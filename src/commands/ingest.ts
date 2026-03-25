import { getLogger } from "@logtape/logtape";
import { Command } from "commander";
import { withDb } from "../db/index";
import { ingest } from "../ingest/index";
import { getShutdownController } from "../utils/shutdown";
import { resolveSourceOption } from "../utils/validation";

const logger = getLogger(["recall", "cli", "ingest"]);

const VALID_SOURCES = ["claude-code", "opencode", "all"] as const;
type IngestSource = (typeof VALID_SOURCES)[number];

function resolveIngestSource(value: string): IngestSource {
	if (value.toLowerCase() === "all") return "all";
	return resolveSourceOption(value);
}

export const ingestCommand = new Command("ingest")
	.description("Ingest sessions from AI coding assistants into the database")
	.option(
		"-s, --source <source>",
		"Source to ingest (claude-code, opencode, all; aliases: cc, oc)",
		"all",
	)
	.option("--since <date>", "Only ingest sessions after this date")
	.option("--force", "Re-ingest all sessions, ignoring ingest log", false)
	.action(async (opts) => {
		const source = resolveIngestSource(opts.source);
		const { signal } = getShutdownController();
		await withDb(async (db) => {
			const results = await ingest(
				db,
				{
					source,
					since: opts.since,
					force: opts.force,
				},
				signal,
			);

			if (results.length === 0) {
				logger.info("No sources to ingest.");
				return;
			}

			for (const r of results) {
				logger.info(
					"{source}: {ingested} ingested, {skipped} skipped ({elapsed}s)",
					{
						source: r.source,
						ingested: r.sessionsIngested,
						skipped: r.sessionsSkipped,
						elapsed: (r.elapsedMs / 1000).toFixed(1),
					},
				);
				for (const err of r.errors) {
					logger.error("{source}: {error}", { source: r.source, error: err });
				}
			}
		});
	});
