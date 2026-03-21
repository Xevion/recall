import { Command } from "commander";
import { all, withDb } from "../db/index";
import { resolveSessionId } from "../db/queries";
import { extractProjectName } from "../utils/path";

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

interface AnalysisDetail {
	session_id: string;
	status: string;
	summary: string | null;
	topics: string[] | null;
	frustrations: string[] | null;
	workflow_notes: string | null;
}

interface SubagentRow {
	id: string;
	title: string | null;
	message_count: number;
	turn_count: number;
}

interface ToolStatRow {
	tool_name: string;
	count: number;
	errors: number;
}

export const showCommand = new Command("show")
	.description("Show detailed session info")
	.argument("<session-id>", "Session ID (or unique prefix)")
	.option("--json", "Output as JSON")
	.action(async (sessionId, opts) => {
		await withDb(async (db) => {
			const resolved = await resolveSessionId(db, sessionId);
			const [session] = await all<SessionDetail>(
				db,
				"SELECT * FROM session WHERE id = ?",
				resolved,
			);
			if (!session) {
				console.error(`Session not found: ${sessionId}`);
				process.exit(1);
			}

			const analysis = await all<AnalysisDetail>(
				db,
				"SELECT * FROM analysis WHERE session_id = ?",
				session.id,
			);
			const subagents = await all<SubagentRow>(
				db,
				"SELECT id, title, message_count, turn_count FROM session WHERE parent_id = ?",
				session.id,
			);
			const toolStats = await all<ToolStatRow>(
				db,
				`SELECT tool_name, COUNT(*) as count, SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors
         FROM tool_call WHERE session_id = ? GROUP BY tool_name ORDER BY count DESC`,
				session.id,
			);

			if (opts.json) {
				console.log(
					JSON.stringify(
						{ session, analysis: analysis[0], subagents, toolStats },
						null,
						2,
					),
				);
			} else {
				const projectDisplay =
					extractProjectName(session.project_path) ??
					session.project_name ??
					"unknown";
				console.log(`Session: ${session.id}`);
				console.log(`Source: ${session.source}`);
				console.log(`Project: ${projectDisplay}`);
				console.log(`Branch: ${session.git_branch ?? "unknown"}`);
				console.log(`Started: ${session.started_at}`);
				console.log(`Duration: ${session.duration_s}s`);
				console.log(
					`Messages: ${session.message_count}, Turns: ${session.turn_count}`,
				);
				console.log(
					`Tokens: ${session.token_input} in / ${session.token_output} out`,
				);

				const a = analysis[0];
				if (a) {
					console.log(`\nAnalysis (${a.status}):`);
					if (a.summary) console.log(`  Summary: ${a.summary}`);
					if (a.topics) console.log(`  Topics: ${a.topics}`);
					if (a.frustrations) console.log(`  Frustrations: ${a.frustrations}`);
					if (a.workflow_notes) console.log(`  Notes: ${a.workflow_notes}`);
				}

				if (subagents.length > 0) {
					console.log(`\nSubagents (${subagents.length}):`);
					for (const sa of subagents) {
						console.log(
							`  ${sa.id} — ${sa.title ?? "untitled"} (${sa.message_count} msgs)`,
						);
					}
				}

				if (toolStats.length > 0) {
					console.log(`\nTool usage:`);
					for (const t of toolStats) {
						const errStr = t.errors > 0 ? ` (${t.errors} errors)` : "";
						console.log(`  ${t.tool_name}: ${t.count}${errStr}`);
					}
				}
			}
		});
	});
