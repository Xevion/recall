import type { DuckDBConnection } from "@duckdb/node-api";
import { all } from "../db/index";
import { formatTopicVocabulary } from "./topics";

/** Tool names whose read results are noise for the analyzer */
const READ_TOOLS = new Set([
	"Read",
	"read_file",
	"ReadFile",
	"Glob",
	"glob",
	"LS",
	"ls",
]);

/** Maximum content length for user messages (preserved generously) */
const USER_CONTENT_LIMIT = 4000;
/** Maximum content length for assistant messages */
const ASSISTANT_CONTENT_LIMIT = 2000;
/** Minimum consecutive same-tool calls to trigger collapsing */
const COLLAPSE_THRESHOLD = 5;

interface MessageRow {
	id: string;
	seq: number;
	role: string;
	model: string | null;
	content: string | null;
	has_tool_use: boolean;
}

interface ToolCallRow {
	message_id: string;
	tool_name: string;
	input_summary: string | null;
	is_error: boolean;
}

interface SessionMeta {
	project_name: string | null;
	git_branch: string | null;
	duration_s: number;
	parent_id: string | null;
	message_count: number;
	turn_count: number;
}

interface SubagentMeta {
	agent_type: string | null;
	prompt: string | null;
}

interface ToolErrorStat {
	tool_name: string;
	total: number;
	errors: number;
}

/**
 * Build a condensed transcript for LLM analysis.
 * Includes pre-computed metadata, role-aware content truncation,
 * tool call collapsing, and topic vocabulary.
 */
export async function buildAnalysisPrompt(
	db: DuckDBConnection,
	sessionId: string,
	isSubagent: boolean,
): Promise<string> {
	const [messages, toolCalls, session, subagent, toolStats] = await Promise.all(
		[
			all<MessageRow>(
				db,
				`SELECT id, seq, role, model, content, has_tool_use FROM message
				 WHERE session_id = ? ORDER BY seq`,
				sessionId,
			),
			all<ToolCallRow>(
				db,
				`SELECT message_id, tool_name, input_summary, is_error FROM tool_call
				 WHERE session_id = ? ORDER BY rowid`,
				sessionId,
			),
			all<SessionMeta>(
				db,
				`SELECT project_name, git_branch, duration_s, parent_id, message_count, turn_count
				 FROM session WHERE id = ?`,
				sessionId,
			).then((rows) => rows[0]),
			all<SubagentMeta>(
				db,
				`SELECT agent_type, prompt FROM subagent WHERE session_id = ?`,
				sessionId,
			).then((rows) => rows[0]),
			all<ToolErrorStat>(
				db,
				`SELECT tool_name, COUNT(*)::INT as total,
				        SUM(CASE WHEN is_error THEN 1 ELSE 0 END)::INT as errors
				 FROM tool_call WHERE session_id = ?
				 GROUP BY tool_name ORDER BY total DESC`,
				sessionId,
			),
		],
	);

	// Group tool calls by message
	const toolsByMessage = new Map<string, ToolCallRow[]>();
	for (const tc of toolCalls) {
		const existing = toolsByMessage.get(tc.message_id) ?? [];
		existing.push(tc);
		toolsByMessage.set(tc.message_id, existing);
	}

	const lines: string[] = [];

	lines.push("# Pre-computed Metadata");
	if (session?.project_name) lines.push(`Project: ${session.project_name}`);
	if (session?.git_branch) lines.push(`Branch: ${session.git_branch}`);
	if (session?.duration_s != null)
		lines.push(`Duration: ${session.duration_s}s`);
	if (session?.message_count != null)
		lines.push(
			`Messages: ${session.message_count} (${session.turn_count ?? 0} turns)`,
		);

	if (isSubagent) {
		lines.push("Type: subagent");
		if (subagent?.agent_type) lines.push(`Agent type: ${subagent.agent_type}`);
		if (subagent?.prompt)
			lines.push(`Dispatch prompt: ${subagent.prompt.slice(0, 500)}`);
	}

	// Tool usage summary
	if (toolStats.length > 0) {
		const totalCalls = toolStats.reduce((s, t) => s + t.total, 0);
		const totalErrors = toolStats.reduce((s, t) => s + t.errors, 0);
		lines.push(`Tool calls: ${totalCalls} (${totalErrors} errors)`);
		if (totalErrors > 0) {
			const errorBreakdown = toolStats
				.filter((t) => t.errors > 0)
				.map((t) => `${t.tool_name}(${t.errors})`)
				.join(", ");
			lines.push(`Error breakdown: ${errorBreakdown}`);
		}
	}

	// User satisfaction signals
	const satisfactionSignals = detectSatisfactionSignals(messages);
	if (satisfactionSignals.length > 0) {
		lines.push(`User signals: ${satisfactionSignals.join(", ")}`);
	}

	lines.push("");

	lines.push(formatTopicVocabulary());
	lines.push("");

	lines.push("# Transcript");

	for (const msg of messages) {
		const roleLabel = msg.role === "user" ? "USER" : "ASSISTANT";
		const contentLimit =
			msg.role === "user" ? USER_CONTENT_LIMIT : ASSISTANT_CONTENT_LIMIT;
		const content = msg.content
			? msg.content.length > contentLimit
				? `${msg.content.slice(0, contentLimit)}...`
				: msg.content
			: "(no text content)";

		lines.push(`\n## ${roleLabel}${msg.model ? ` [${msg.model}]` : ""}`);
		lines.push(content);

		if (msg.has_tool_use) {
			const tools = toolsByMessage.get(msg.id) ?? [];
			const formatted = formatToolCalls(tools);
			for (const line of formatted) {
				lines.push(line);
			}
		}
	}

	return lines.join("\n");
}

/**
 * Format tool calls with collapsing for repetitive patterns.
 * Error tool calls are always shown individually with full detail.
 */
function formatToolCalls(tools: ToolCallRow[]): string[] {
	const lines: string[] = [];
	let i = 0;

	while (i < tools.length) {
		const tc = tools[i]!;

		// Error tool calls are always shown in full
		if (tc.is_error) {
			lines.push(`  → ${tc.tool_name} [ERROR]: ${tc.input_summary ?? ""}`);
			i++;
			continue;
		}

		// Check for a run of the same non-error tool
		let runEnd = i + 1;
		while (
			runEnd < tools.length &&
			tools[runEnd]?.tool_name === tc.tool_name &&
			!tools[runEnd]?.is_error
		) {
			runEnd++;
		}
		const runLength = runEnd - i;

		if (runLength >= COLLAPSE_THRESHOLD) {
			// Collapse: collect unique summaries
			const summaries = new Set<string>();
			for (let j = i; j < runEnd; j++) {
				const summary = tools[j]?.input_summary;
				if (summary) summaries.add(summary);
			}
			const summaryStr =
				summaries.size > 0
					? ` (${[...summaries].slice(0, 5).join(", ")}${summaries.size > 5 ? ", ..." : ""})`
					: "";
			lines.push(`  → ${tc.tool_name} x${runLength}${summaryStr}`);
			i = runEnd;
		} else if (READ_TOOLS.has(tc.tool_name)) {
			// Read-like tools: show name + path only (no content)
			lines.push(`  → ${tc.tool_name}: ${tc.input_summary ?? ""}`);
			i++;
		} else {
			// Normal tool call
			lines.push(`  → ${tc.tool_name}: ${tc.input_summary ?? ""}`);
			i++;
		}
	}

	return lines;
}

/**
 * Detect user satisfaction/frustration signals from message content.
 */
function detectSatisfactionSignals(messages: MessageRow[]): string[] {
	const signals: string[] = [];
	const positivePatterns =
		/\b(perfect|exactly|great|thanks|thank you|nice|awesome|looks good|lgtm)\b/i;
	const negativePatterns =
		/\b(no[,.]? (?:not that|wrong|stop)|that's wrong|undo|revert|start over|you broke)\b/i;

	for (const msg of messages) {
		if (msg.role !== "user" || !msg.content) continue;
		if (positivePatterns.test(msg.content)) {
			signals.push(`positive at msg ${msg.seq}`);
		}
		if (negativePatterns.test(msg.content)) {
			signals.push(`correction at msg ${msg.seq}`);
		}
	}

	return signals;
}
