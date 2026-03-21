import { Command } from "commander";
import { getDb, close } from "../db/index";
import { getToolStats } from "../db/queries";

export const toolsCommand = new Command("tools")
  .description("Tool usage breakdown across sessions")
  .option("--since <date>", "Filter by date")
  .option("-p, --project <name>", "Filter by project")
  .option("--sort <by>", "Sort by: frequency, errors, duration", "frequency")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const db = await getDb();
    try {
      const stats = await getToolStats(db, {
        since: opts.since,
        project: opts.project,
        sort: opts.sort,
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
    } finally {
      await close();
    }
  });
