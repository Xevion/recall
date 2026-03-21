import { Command } from "commander";
import { all, close, getDb } from "../db/index";

export const showCommand = new Command("show")
	.description("Show detailed session info")
	.argument("<session-id>", "Session ID to show")
	.option("--json", "Output as JSON")
	.action(async (sessionId, opts) => {
		const db = await getDb();
		try {
			const [session] = await all(
				db,
				"SELECT * FROM session WHERE id = ? OR id LIKE ?",
				sessionId,
				`${sessionId}%`,
			);
			if (!session) {
				console.error(`Session not found: ${sessionId}`);
				process.exit(1);
			}

			const analysis = await all(
				db,
				"SELECT * FROM analysis WHERE session_id = ?",
				(session as Record<string, unknown>).id,
			);
			const subagents = await all(
				db,
				"SELECT id, title, message_count, turn_count FROM session WHERE parent_id = ?",
				(session as Record<string, unknown>).id,
			);
			const toolStats = await all(
				db,
				`SELECT tool_name, COUNT(*) as count, SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors
         FROM tool_call WHERE session_id = ? GROUP BY tool_name ORDER BY count DESC`,
				(session as Record<string, unknown>).id,
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
				const s = session as Record<string, unknown>;
				console.log(`Session: ${s.id}`);
				console.log(`Source: ${s.source}`);
				console.log(`Project: ${s.project_name ?? "unknown"}`);
				console.log(`Branch: ${s.git_branch ?? "unknown"}`);
				console.log(`Started: ${s.started_at}`);
				console.log(`Duration: ${s.duration_s}s`);
				console.log(`Messages: ${s.message_count}, Turns: ${s.turn_count}`);
				console.log(`Tokens: ${s.token_input} in / ${s.token_output} out`);

				if (analysis[0]) {
					const a = analysis[0] as Record<string, unknown>;
					console.log(`\nAnalysis (${a.status}):`);
					if (a.summary) console.log(`  Summary: ${a.summary}`);
					if (a.topics) console.log(`  Topics: ${a.topics}`);
					if (a.frustrations) console.log(`  Frustrations: ${a.frustrations}`);
					if (a.workflow_notes) console.log(`  Notes: ${a.workflow_notes}`);
				}

				if (subagents.length > 0) {
					console.log(`\nSubagents (${subagents.length}):`);
					for (const sa of subagents as Array<Record<string, unknown>>) {
						console.log(
							`  ${sa.id} — ${sa.title ?? "untitled"} (${sa.message_count} msgs)`,
						);
					}
				}

				if ((toolStats as unknown[]).length > 0) {
					console.log(`\nTool usage:`);
					for (const t of toolStats as Array<Record<string, unknown>>) {
						const errStr =
							(t.errors as number) > 0 ? ` (${t.errors} errors)` : "";
						console.log(`  ${t.tool_name}: ${t.count}${errStr}`);
					}
				}
			}
		} finally {
			await close();
		}
	});
