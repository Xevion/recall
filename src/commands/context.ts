import { getLogger } from "@logtape/logtape";
import { Command } from "commander";
import { withDb } from "../db/index";
import { getProjectContext } from "../db/queries";
import {
	parseIntOption,
	parseRelativeDate,
	resolveProjectOption,
} from "../utils/validation";

const logger = getLogger(["recall", "cli", "context"]);

export const contextCommand = new Command("context")
	.description("Show recent project context for AI session continuity")
	.option(
		"-p, --project [name]",
		"Filter by project (auto-detects from cwd if no name given)",
	)
	.option(
		"--since <date>",
		"Only include sessions after this date (default: 14d)",
		"14d",
	)
	.option("-l, --limit <n>", "Maximum sessions to include", "10")
	.option("--pretty", "Pretty-print JSON output")
	.action(async (opts) => {
		const project = resolveProjectOption(opts.project);
		if (!project) {
			logger.error(
				"No project specified. Use --project or run from a project directory with --project (bare).",
			);
			process.exit(1);
		}

		const since = parseRelativeDate(opts.since);
		const limit = parseIntOption(opts.limit, "limit");

		await withDb(async (db) => {
			const ctx = await getProjectContext(db, { project, since, limit });

			if (ctx.session_count === 0 && ctx.unanalyzed_count > 0) {
				logger.warn(
					"No analyzed sessions found. {count} session(s) pending analysis — run: recall analyze --project {project} --since {since}",
					{ count: ctx.unanalyzed_count, project, since: opts.since },
				);
			}

			const indent = opts.pretty ? 2 : undefined;
			console.log(JSON.stringify(ctx, null, indent));
		});
	});
