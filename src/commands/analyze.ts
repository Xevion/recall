import { getLogger } from "@logtape/logtape";
import { Command } from "commander";
import { analyze } from "../analyze/index";
import { withDb } from "../db/index";
import { resolveSessionId } from "../db/queries";
import { parseIntOption, parseRelativeDate } from "../utils/validation";

const logger = getLogger(["recall", "cli", "analyze"]);

export const analyzeCommand = new Command("analyze")
	.description("Run AI analysis on pending sessions")
	.option("-l, --limit <n>", "Maximum sessions to analyze", "100")
	.option("--force <id>", "Force re-analyze a specific session")
	.option("-p, --project <name>", "Filter to sessions matching project name")
	.option(
		"--since <date>",
		"Only analyze sessions after this date (e.g., 3d, 1w, yesterday)",
	)
	.option("--dry-run", "Show what would be analyzed without running LLM calls")
	.action(async (opts) => {
		await withDb(async (db) => {
			let force: string | undefined;
			if (opts.force) {
				force = await resolveSessionId(db, opts.force);
			}
			const since = opts.since ? parseRelativeDate(opts.since) : undefined;
			const result = await analyze(db, {
				limit: parseIntOption(opts.limit, "limit"),
				force,
				project: opts.project,
				since,
				dryRun: opts.dryRun,
			});
			if (opts.dryRun) {
				logger.info("Dry run: {analyzed} to analyze, {skipped} to skip", {
					...result,
				});
			} else {
				logger.info(
					"Analyzed: {analyzed}, Skipped: {skipped}, Errors: {errors}, Refused: {refused}",
					{ ...result },
				);
			}
		});
	});
