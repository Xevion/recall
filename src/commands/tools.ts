import { Command } from "commander";
import { close, getDb } from "../db/index";
import { getAvailableProjects, getToolStats } from "../db/queries";
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

		const db = await getDb();
		try {
			const stats = await getToolStats(db, {
				since,
				project: opts.project,
				sort,
			});

			if (opts.json) {
				console.log(JSON.stringify(stats, null, 2));
			} else {
				console.log(
					["Tool", "Calls", "Errors", "Error%", "Avg ms"]
						.map((h) => h.padEnd(16))
						.join(""),
				);
				console.log("-".repeat(80));
				for (const s of stats as Array<Record<string, unknown>>) {
					console.log(
						[
							String(s.tool_name).slice(0, 14),
							String(s.call_count),
							String(s.error_count),
							`${s.error_rate}%`,
							String(s.avg_duration_ms ?? "-"),
						]
							.map((v) => v.padEnd(16))
							.join(""),
					);
				}
			}
			if ((stats as unknown[]).length === 0 && opts.project && !opts.json) {
				const available = await getAvailableProjects(db);
				const suggestions = suggestProject(opts.project, available);
				if (suggestions.length > 0) {
					console.error(c.overlay1(`Did you mean: ${suggestions.join(", ")}?`));
				}
			}
		} finally {
			await close();
		}
	});
