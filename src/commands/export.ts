import { getLogger } from "@logtape/logtape";
import { Command } from "commander";
import { all, withDb } from "../db/index";
import { resolveSessionId } from "../db/queries";
import { formatDuration } from "../utils/format";
import { extractProjectName } from "../utils/path";

const logger = getLogger(["recall", "cli", "export"]);

interface SessionDetail {
	id: string;
	source: string;
	parent_id: string | null;
	project_path: string | null;
	project_name: string | null;
	git_branch: string | null;
	title: string | null;
	started_at: string;
	ended_at: string | null;
	message_count: number;
	turn_count: number;
	token_input: number;
	token_output: number;
	duration_s: number;
	source_path: string;
}

interface FrustrationItem {
	category: string;
	description: string;
	severity: string;
}

interface AnalysisDetail {
	session_id: string;
	status: string;
	title: string | null;
	summary: string | null;
	outcome: string | null;
	outcome_confidence: string | null;
	session_types: string[] | null;
	topics: string[] | null;
	frustrations: string | null;
	actionable_insight: string | null;
}

interface MessageRow {
	id: string;
	role: string;
	model: string | null;
	seq: number;
	timestamp: string | null;
	token_input: number;
	token_output: number;
	content: string | null;
	has_tool_use: boolean;
}

interface ToolCallRow {
	id: string;
	message_id: string;
	tool_name: string;
	input_summary: string | null;
	is_error: boolean;
	duration_ms: number | null;
}

interface SubagentRow {
	id: string;
	title: string | null;
	message_count: number;
	turn_count: number;
	agent_type: string | null;
	description: string | null;
}

export const exportCommand = new Command("export")
	.description("Export a full session transcript")
	.argument("<session-id>", "Session ID (or unique prefix)")
	.option("--format <fmt>", "Output format: json or md", "json")
	.action(async (sessionId, opts) => {
		const format = opts.format as string;
		if (format !== "json" && format !== "md") {
			logger.error('Invalid format "{format}" — use "json" or "md"', {
				format,
			});
			process.exit(1);
		}

		await withDb(async (db) => {
			const resolved = await resolveSessionId(db, sessionId);

			const [session] = await all<SessionDetail>(
				db,
				"SELECT * FROM session WHERE id = ?",
				resolved,
			);
			if (!session) {
				logger.error("Session not found: {sessionId}", { sessionId });
				process.exit(1);
			}

			const analysis = await all<AnalysisDetail>(
				db,
				"SELECT * FROM analysis WHERE session_id = ?",
				session.id,
			);

			const messages = await all<MessageRow>(
				db,
				"SELECT id, role, model, seq, timestamp, token_input, token_output, content, has_tool_use FROM message WHERE session_id = ? ORDER BY seq",
				session.id,
			);

			const toolCalls = await all<ToolCallRow>(
				db,
				"SELECT id, message_id, tool_name, input_summary, is_error, duration_ms FROM tool_call WHERE session_id = ? ORDER BY id",
				session.id,
			);

			const subagents = await all<SubagentRow>(
				db,
				`SELECT s.id, s.title, s.message_count, s.turn_count, sa.agent_type, sa.description
				 FROM session s
				 LEFT JOIN subagent sa ON sa.session_id = s.id
				 WHERE s.parent_id = ?`,
				session.id,
			);

			// Index tool calls by message_id for quick lookup
			const toolsByMessage = new Map<string, ToolCallRow[]>();
			for (const tc of toolCalls) {
				const list = toolsByMessage.get(tc.message_id) ?? [];
				list.push(tc);
				toolsByMessage.set(tc.message_id, list);
			}

			if (format === "json") {
				const output = {
					session,
					analysis: analysis[0] ?? null,
					messages: messages.map((m) => ({
						...m,
						toolCalls: toolsByMessage.get(m.id) ?? [],
					})),
					subagents,
				};
				console.log(JSON.stringify(output, null, 2));
			} else {
				console.log(
					renderMarkdown(
						session,
						analysis[0] ?? null,
						messages,
						toolsByMessage,
						subagents,
					),
				);
			}
		});
	});

function renderMarkdown(
	session: SessionDetail,
	analysis: AnalysisDetail | null,
	messages: MessageRow[],
	toolsByMessage: Map<string, ToolCallRow[]>,
	subagents: SubagentRow[],
): string {
	const lines: string[] = [];
	const project =
		extractProjectName(session.project_path) ??
		session.project_name ??
		"unknown";

	lines.push(`# Session ${session.id}`);
	lines.push("");
	lines.push(`- **Source:** ${session.source}`);
	lines.push(`- **Project:** ${project}`);
	if (session.git_branch) lines.push(`- **Branch:** ${session.git_branch}`);
	lines.push(`- **Started:** ${session.started_at}`);
	if (session.ended_at) lines.push(`- **Ended:** ${session.ended_at}`);
	lines.push(`- **Duration:** ${formatDuration(session.duration_s)}`);
	lines.push(
		`- **Messages:** ${session.message_count}, **Turns:** ${session.turn_count}`,
	);
	lines.push(
		`- **Tokens:** ${session.token_input} in / ${session.token_output} out`,
	);

	if (analysis) {
		lines.push("");
		lines.push(`## Analysis (${analysis.status})`);
		if (analysis.title) {
			lines.push("");
			lines.push(`**${analysis.title}**`);
		}
		if (analysis.summary) {
			lines.push("");
			lines.push(analysis.summary);
		}
		if (analysis.outcome) {
			lines.push("");
			lines.push(
				`**Outcome:** ${analysis.outcome} (${analysis.outcome_confidence ?? "?"} confidence)`,
			);
		}
		if (analysis.session_types?.length) {
			lines.push("");
			lines.push(`**Session type:** ${analysis.session_types.join(", ")}`);
		}
		if (analysis.topics?.length) {
			lines.push("");
			lines.push(`**Topics:** ${analysis.topics.join(", ")}`);
		}
		if (analysis.frustrations) {
			let items: FrustrationItem[];
			try {
				items =
					typeof analysis.frustrations === "string"
						? JSON.parse(analysis.frustrations)
						: analysis.frustrations;
			} catch {
				items = [];
			}
			if (items.length > 0) {
				lines.push("");
				lines.push("**Frustrations:**");
				for (const f of items) {
					lines.push(`- [${f.severity}/${f.category}] ${f.description}`);
				}
			}
		}
		if (analysis.actionable_insight) {
			lines.push("");
			lines.push(`**Insight:** ${analysis.actionable_insight}`);
		}
	}

	if (subagents.length > 0) {
		lines.push("");
		lines.push(`## Subagents (${subagents.length})`);
		lines.push("");
		for (const sa of subagents) {
			const desc = sa.description ?? sa.title ?? "untitled";
			const type = sa.agent_type ? ` (${sa.agent_type})` : "";
			lines.push(
				`- \`${sa.id}\`${type} — ${desc} (${sa.message_count} msgs, ${sa.turn_count} turns)`,
			);
		}
	}

	lines.push("");
	lines.push("## Transcript");
	lines.push("");

	for (const msg of messages) {
		const role = msg.role === "assistant" ? "Assistant" : "User";
		const ts = msg.timestamp
			? new Date(msg.timestamp).toLocaleTimeString()
			: "";
		const model = msg.model ? ` (${msg.model})` : "";

		lines.push(`### ${role}${model} ${ts ? `— ${ts}` : ""}`);
		lines.push("");

		if (msg.content) {
			lines.push(msg.content);
			lines.push("");
		}

		const tools = toolsByMessage.get(msg.id);
		if (tools?.length) {
			for (const tc of tools) {
				const errorTag = tc.is_error ? " **ERROR**" : "";
				const durationTag =
					tc.duration_ms != null ? ` (${tc.duration_ms}ms)` : "";
				const summary = tc.input_summary ?? "";

				lines.push(
					`<details><summary><code>${tc.tool_name}</code>${errorTag}${durationTag} ${summary}</summary>`,
				);
				lines.push("");
				lines.push(`Tool call ID: \`${tc.id}\``);
				lines.push("");
				lines.push("</details>");
				lines.push("");
			}
		}
	}

	return lines.join("\n");
}
