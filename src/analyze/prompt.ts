import type duckdb from "duckdb";
import { all } from "../db/index";

/**
 * Build a condensed transcript for LLM analysis.
 * Includes message roles, tool call names/errors, and text content (truncated).
 * Excludes full tool output to stay within reasonable token budgets.
 */
export async function buildAnalysisPrompt(
	db: duckdb.Database,
	sessionId: string,
): Promise<string> {
	const messages = await all<{
		seq: number;
		role: string;
		model: string | null;
		content: string | null;
		has_tool_use: boolean;
	}>(
		db,
		`SELECT seq, role, model, content, has_tool_use FROM message
     WHERE session_id = ? ORDER BY seq`,
		sessionId,
	);

	const toolCalls = await all<{
		message_id: string;
		tool_name: string;
		input_summary: string | null;
		is_error: boolean;
	}>(
		db,
		`SELECT message_id, tool_name, input_summary, is_error FROM tool_call
     WHERE session_id = ? ORDER BY rowid`,
		sessionId,
	);

	// Group tool calls by message
	const toolsByMessage = new Map<string, typeof toolCalls>();
	for (const tc of toolCalls) {
		const existing = toolsByMessage.get(tc.message_id) ?? [];
		existing.push(tc);
		toolsByMessage.set(tc.message_id, existing);
	}

	// Get session metadata
	const [session] = await all<{
		project_name: string | null;
		git_branch: string | null;
		duration_s: number;
		parent_id: string | null;
	}>(
		db,
		`SELECT project_name, git_branch, duration_s, parent_id FROM session WHERE id = ?`,
		sessionId,
	);

	// Get subagent info if applicable
	const [subagent] = await all<{
		agent_type: string | null;
		prompt: string | null;
	}>(
		db,
		`SELECT agent_type, prompt FROM subagent WHERE session_id = ?`,
		sessionId,
	);

	const lines: string[] = [];

	lines.push("# Session Context");
	if (session?.project_name) lines.push(`Project: ${session.project_name}`);
	if (session?.git_branch) lines.push(`Branch: ${session.git_branch}`);
	if (session?.duration_s) lines.push(`Duration: ${session.duration_s}s`);
	if (session?.parent_id) lines.push(`Type: subagent`);
	if (subagent?.agent_type) lines.push(`Agent type: ${subagent.agent_type}`);
	if (subagent?.prompt)
		lines.push(`Dispatch prompt: ${subagent.prompt.slice(0, 500)}`);
	lines.push("");
	lines.push("# Transcript");

	for (const msg of messages) {
		const roleLabel = msg.role === "user" ? "USER" : "ASSISTANT";
		const content = msg.content
			? msg.content.length > 500
				? msg.content.slice(0, 500) + "..."
				: msg.content
			: "(no text content)";

		lines.push(`\n## ${roleLabel}${msg.model ? ` [${msg.model}]` : ""}`);
		lines.push(content);

		if (msg.has_tool_use) {
			const msgId = `msg-${msg.seq}`; // approximate
			const tools = toolsByMessage.get(msgId) ?? [];
			for (const tc of tools) {
				const errorTag = tc.is_error ? " [ERROR]" : "";
				lines.push(`  → ${tc.tool_name}${errorTag}: ${tc.input_summary ?? ""}`);
			}
		}
	}

	return lines.join("\n");
}
