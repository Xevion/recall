import { Command } from "commander";
import { close, getDb } from "../db/index";
import { listSessions } from "../db/queries";

export const sessionsCommand = new Command("sessions")
	.description("List sessions")
	.option("-p, --project <name>", "Filter by project name")
	.option("-s, --source <type>", "Filter by source (claude-code, opencode)")
	.option("--since <date>", "Sessions after this date")
	.option("-l, --limit <n>", "Number of sessions to show", "20")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const db = await getDb();
		try {
			const sessions = await listSessions(db, {
				project: opts.project,
				source: opts.source,
				since: opts.since,
				limit: parseInt(opts.limit),
			});

			if (opts.json) {
				console.log(JSON.stringify(sessions, null, 2));
			} else {
				// Simple table output
				console.log(
					["ID", "Source", "Project", "Started", "Msgs", "Turns", "Duration"]
						.map((h) => h.padEnd(16))
						.join(""),
				);
				console.log("-".repeat(112));
				for (const s of sessions) {
					console.log(
						[
							s.id.slice(0, 14),
							s.source,
							(s.project_name ?? "").slice(0, 14),
							new Date(s.started_at).toLocaleDateString(),
							String(s.message_count ?? 0),
							String(s.turn_count ?? 0),
							`${s.duration_s ?? 0}s`,
						]
							.map((v) => v.padEnd(16))
							.join(""),
					);
				}
			}
		} finally {
			await close();
		}
	});
