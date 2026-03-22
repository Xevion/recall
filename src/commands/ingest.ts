import { getLogger } from "@logtape/logtape";
import { Command } from "commander";
import { withDb } from "../db/index";
import { ingest } from "../ingest/index";

const logger = getLogger(["recall", "cli", "ingest"]);

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
		await withDb(async (db) => {
			const results = await ingest(db, {
				source: opts.source,
				since: opts.since,
				force: opts.force,
			});

			for (const r of results) {
				logger.info("{source}: {ingested} ingested, {skipped} skipped", {
					source: r.source,
					ingested: r.sessionsIngested,
					skipped: r.sessionsSkipped,
				});
				for (const err of r.errors) {
					logger.error("{source}: {error}", { source: r.source, error: err });
				}
			}
		});
	});
