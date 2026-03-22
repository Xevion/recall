import { getLogger } from "@logtape/logtape";
import { Command } from "commander";
import { analyze } from "../analyze/index";
import { withDb } from "../db/index";
import { resolveSessionId } from "../db/queries";
import { parseIntOption } from "../utils/validation";

const logger = getLogger(["recall", "cli", "analyze"]);

export const analyzeCommand = new Command("analyze")
	.description("Run AI analysis on pending sessions")
	.option("-l, --limit <n>", "Maximum sessions to analyze", "100")
	.option("--force <id>", "Force re-analyze a specific session")
	.action(async (opts) => {
		await withDb(async (db) => {
			let force: string | undefined;
			if (opts.force) {
				force = await resolveSessionId(db, opts.force);
			}
			const result = await analyze(db, {
				limit: parseIntOption(opts.limit, "limit"),
				force,
			});
			logger.info(
				"Analyzed: {analyzed}, Skipped: {skipped}, Errors: {errors}, Refused: {refused}",
				{ ...result },
			);
		});
	});
