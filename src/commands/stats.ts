import Table from "cli-table3";
import { Command } from "commander";
import { all, withDb } from "../db/index";
import { formatDuration, formatTokens } from "../utils/format";
import { BORDERLESS_CHARS, c } from "../utils/theme";
import { parseRelativeDate, resolveEnumOption } from "../utils/validation";

const VALID_PERIODS = ["day", "week", "month"] as const;

interface StatsRow {
	period: string;
	sessions: number;
	messages: number;
	turns: number;
	tokens_in: number;
	tokens_out: number;
	total_duration_s: number;
}

export const statsCommand = new Command("stats")
	.description("Aggregate usage statistics")
	.option("--since <date>", "Stats after this date")
	.option("--by <period>", "Group by: day, week, month", "day")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const period = resolveEnumOption(opts.by, VALID_PERIODS, "by");
		const since = opts.since ? parseRelativeDate(opts.since) : undefined;

		await withDb(async (db) => {
			const truncFn = {
				day: "date_trunc('day', started_at)",
				week: "date_trunc('week', started_at)",
				month: "date_trunc('month', started_at)",
			}[period];

			const conditions = ["parent_id IS NULL"];
			const params: unknown[] = [];
			if (since) {
				conditions.push("started_at >= ?");
				params.push(since);
			}

			const where = `WHERE ${conditions.join(" AND ")}`;

			const results = await all<StatsRow>(
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
				const table = new Table({
					head: [
						"Period",
						"Sessions",
						"Messages",
						"Turns",
						"Tokens In",
						"Tokens Out",
						"Duration",
					].map((h) => c.text.bold(h)),
					colAligns: [
						"left",
						"right",
						"right",
						"right",
						"right",
						"right",
						"right",
					],
					colWidths: [14, 10, 10, 8, 12, 12, 10],
					style: {
						head: [],
						border: [],
						"padding-left": 0,
						"padding-right": 0,
					},
					chars: BORDERLESS_CHARS,
				});

				for (const r of results) {
					table.push([
						c.text(new Date(r.period).toLocaleDateString()),
						c.subtext0(String(r.sessions)),
						c.subtext0(String(r.messages)),
						c.subtext0(String(r.turns)),
						c.overlay1(formatTokens(r.tokens_in)),
						c.overlay1(formatTokens(r.tokens_out)),
						c.overlay1(formatDuration(r.total_duration_s)),
					]);
				}

				console.log(table.toString());
				console.log(c.overlay1(`\n${results.length} period(s)`));
			}
		});
	});
