import { Command } from "commander";
import { getDb, close } from "../db/index";
import { analyze } from "../analyze/index";

export const analyzeCommand = new Command("analyze")
  .description("Run AI analysis on pending sessions")
  .option("-l, --limit <n>", "Maximum sessions to analyze", "100")
  .option("--force <id>", "Force re-analyze a specific session")
  .action(async (opts) => {
    const db = await getDb();
    try {
      const result = await analyze(db, {
        limit: parseInt(opts.limit),
        force: opts.force,
      });
      console.log(
        `Analyzed: ${result.analyzed}, Skipped: ${result.skipped}, Errors: ${result.errors}, Refused: ${result.refused}`,
      );
    } finally {
      await close();
    }
  });
