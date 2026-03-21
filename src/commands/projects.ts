import { Command } from "commander";
import { all, close, getDb } from "../db/index";

export const projectsCommand = new Command("projects")
	.description("Project-level activity summary")
	.option("--sort <by>", "Sort by: recent, sessions, tokens", "recent")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const db = await getDb();
		try {
			const orderBy =
				{
					recent: "last_active DESC",
					sessions: "session_count DESC",
					tokens: "total_tokens DESC",
				}[opts.sort as string] ?? "last_active DESC";

			const results = await all(
				db,
				`SELECT
           project_name,
           COUNT(*) as session_count,
           SUM(token_input + token_output) as total_tokens,
           SUM(duration_s) as total_duration_s,
           MAX(started_at) as last_active,
           MIN(started_at) as first_active
         FROM session
         WHERE project_name IS NOT NULL AND parent_id IS NULL
         GROUP BY project_name
         ORDER BY ${orderBy}`,
			);

			if (opts.json) {
				console.log(JSON.stringify(results, null, 2));
			} else {
				console.log(
					["Project", "Sessions", "Tokens", "Duration", "Last Active"]
						.map((h) => h.padEnd(20))
						.join(""),
				);
				console.log("-".repeat(100));
				for (const r of results as Array<Record<string, unknown>>) {
					console.log(
						[
							String(r.project_name).slice(0, 18),
							String(r.session_count),
							String(r.total_tokens),
							`${Math.round((r.total_duration_s as number) / 60)}m`,
							new Date(r.last_active as string).toLocaleDateString(),
						]
							.map((v) => v.padEnd(20))
							.join(""),
					);
				}
			}
		} finally {
			await close();
		}
	});
