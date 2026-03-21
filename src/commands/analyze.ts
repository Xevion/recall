import { Command } from "commander";
import { analyze } from "../analyze/index";
import { close, getDb } from "../db/index";
import { resolveSessionId } from "../db/queries";

export const analyzeCommand = new Command("analyze")
	.description("Run AI analysis on pending sessions")
	.option("-l, --limit <n>", "Maximum sessions to analyze", "100")
	.option("--force <id>", "Force re-analyze a specific session")
	.action(async (opts) => {
		const db = await getDb();
		try {
			let force: string | undefined;
			if (opts.force) {
				const resolved = await resolveSessionId(db, opts.force);
				if (!resolved) return;
				force = resolved;
			}
			const result = await analyze(db, {
				limit: parseInt(opts.limit, 10),
				force,
			});
			console.log(
				`Analyzed: ${result.analyzed}, Skipped: ${result.skipped}, Errors: ${result.errors}, Refused: ${result.refused}`,
			);
		} finally {
			await close();
		}
	});
