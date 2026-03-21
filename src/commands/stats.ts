import { Command } from "commander";
import { all, close, getDb } from "../db/index";

export const statsCommand = new Command("stats")
	.description("Aggregate usage statistics")
	.option("--since <date>", "Stats after this date")
	.option("--by <period>", "Group by: day, week, month", "day")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const db = await getDb();
		try {
			const truncFn =
				{
					day: "date_trunc('day', started_at)",
					week: "date_trunc('week', started_at)",
					month: "date_trunc('month', started_at)",
				}[opts.by as string] ?? "date_trunc('day', started_at)";

			const conditions = ["parent_id IS NULL"];
			const params: unknown[] = [];
			if (opts.since) {
				conditions.push("started_at >= ?");
				params.push(opts.since);
			}

			const where =
				conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

			const results = await all(
				db,
				`SELECT
           ${truncFn} as period,
           COUNT(*) as sessions,
           SUM(message_count) as messages,
           SUM(turn_count) as turns,
           SUM(token_input) as tokens_in,
           SUM(token_output) as tokens_out,
           SUM(duration_s) as total_duration_s
         FROM session
         ${where}
         GROUP BY period
         ORDER BY period DESC
         LIMIT 30`,
				...params,
			);

			if (opts.json) {
				console.log(JSON.stringify(results, null, 2));
			} else {
				console.log(
					[
						"Period",
						"Sessions",
						"Messages",
						"Turns",
						"Tokens In",
						"Tokens Out",
						"Duration",
					]
						.map((h) => h.padEnd(14))
						.join(""),
				);
				console.log("-".repeat(98));
				for (const r of results as Array<Record<string, unknown>>) {
					console.log(
						[
							new Date(r.period as string).toLocaleDateString(),
							String(r.sessions),
							String(r.messages),
							String(r.turns),
							String(r.tokens_in),
							String(r.tokens_out),
							`${Math.round((r.total_duration_s as number) / 60)}m`,
						]
							.map((v) => v.padEnd(14))
							.join(""),
					);
				}
			}
		} finally {
			await close();
		}
	});
