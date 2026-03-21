import { Command } from "commander";
import { close, getDb } from "../db/index";
import { ingest } from "../ingest/index";

export const ingestCommand = new Command("ingest")
	.description("Ingest sessions from AI coding assistants into the database")
	.option(
		"-s, --source <source>",
		"Source to ingest (claude-code, opencode, all)",
		"all",
	)
	.option("--since <date>", "Only ingest sessions after this date")
	.option("--force", "Re-ingest all sessions, ignoring ingest log", false)
	.action(async (opts) => {
		const db = await getDb();
		try {
			const results = await ingest(db, {
				source: opts.source,
				since: opts.since,
				force: opts.force,
			});

			for (const r of results) {
				console.log(
					`${r.source}: ${r.sessionsIngested} ingested, ${r.sessionsSkipped} skipped`,
				);
				for (const err of r.errors) {
					console.error(`  error: ${err}`);
				}
			}
		} finally {
			await close();
		}
	});
