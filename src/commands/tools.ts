import { Command } from "commander";
import { withDb } from "../db/index";
import { getAvailableProjects, getToolStats } from "../db/queries";
import { createTable, printFooter } from "../utils/table";
import { c } from "../utils/theme";
import {
	parseRelativeDate,
	resolveEnumOption,
	suggestProject,
} from "../utils/validation";

const VALID_SORTS = ["frequency", "errors", "duration"] as const;

export const toolsCommand = new Command("tools")
	.description("Tool usage breakdown across sessions")
	.option("--since <date>", "Filter by date")
	.option("-p, --project <name>", "Filter by project")
	.option("--sort <by>", "Sort by: frequency, errors, duration", "frequency")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const sort = resolveEnumOption(opts.sort, VALID_SORTS, "sort");
		const since = opts.since ? parseRelativeDate(opts.since) : undefined;

		await withDb(async (db) => {
			const stats = await getToolStats(db, {
				since,
				project: opts.project,
				sort,
			});

			if (opts.json) {
				console.log(JSON.stringify(stats, null, 2));
			} else {
				const table = createTable({
					head: ["Tool", "Calls", "Errors", "Error%", "Avg ms"],
					colAligns: ["left", "right", "right", "right", "right"],
					colWidths: [24, 10, 10, 10, 10],
				});

				for (const s of stats) {
					table.push([
						c.text(s.tool_name),
						c.subtext0(String(s.call_count)),
						s.error_count > 0
							? c.catRed(String(s.error_count))
							: c.overlay0(String(s.error_count)),
						s.error_rate > 5
							? c.catRed(`${s.error_rate}%`)
							: c.subtext0(`${s.error_rate}%`),
						c.overlay1(String(s.avg_duration_ms ?? "—")),
					]);
				}

				console.log(table.toString());
				printFooter(stats.length, "tool");

				if (stats.length === 0 && opts.project) {
					const available = await getAvailableProjects(db);
					const suggestions = suggestProject(opts.project, available);
					if (suggestions.length > 0) {
						console.error(
							c.overlay1(`Did you mean: ${suggestions.join(", ")}?`),
						);
					}
				}
			}
		});
	});
