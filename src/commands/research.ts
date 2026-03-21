import { Command } from "commander";
import { getDb, close, all } from "../db/index";

export const researchCommand = new Command("research")
  .description("Browse and search research artifacts")
  .option("--topic <query>", "Search by topic")
  .option("--tags <tag>", "Filter by tag")
  .option("--list", "List all research artifacts")
  .option("-l, --limit <n>", "Number of results", "20")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const db = await getDb();
    try {
      let results;

      if (opts.topic) {
        results = await all(
          db,
          `SELECT id, topic, tags, created_at, length(content) as content_length
           FROM research_artifact
           WHERE topic ILIKE ? OR content ILIKE ?
           ORDER BY created_at DESC LIMIT ?`,
          `%${opts.topic}%`,
          `%${opts.topic}%`,
          parseInt(opts.limit),
        );
      } else if (opts.tags) {
        results = await all(
          db,
          `SELECT id, topic, tags, created_at, length(content) as content_length
           FROM research_artifact
           WHERE list_contains(tags, ?)
           ORDER BY created_at DESC LIMIT ?`,
          opts.tags,
          parseInt(opts.limit),
        );
      } else {
        results = await all(
          db,
          `SELECT id, topic, tags, created_at, length(content) as content_length
           FROM research_artifact
           ORDER BY created_at DESC LIMIT ?`,
          parseInt(opts.limit),
        );
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        if ((results as unknown[]).length === 0) {
          console.log("No research artifacts found.");
          return;
        }
        for (const r of results as Array<Record<string, unknown>>) {
          console.log(`${r.id}`);
          console.log(`  Topic: ${r.topic}`);
          console.log(`  Tags: ${r.tags}`);
          console.log(`  Size: ${r.content_length} chars`);
          console.log();
        }
      }
    } finally {
      await close();
    }
  });
