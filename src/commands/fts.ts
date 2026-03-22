import { getLogger } from "@logtape/logtape";
import { Command } from "commander";
import { rebuildFtsIndexes } from "../db/fts";
import { withDb } from "../db/index";

const logger = getLogger(["recall", "cli", "fts"]);

const rebuildCommand = new Command("rebuild")
	.description("Rebuild all full-text search indexes")
	.action(async () => {
		const start = performance.now();
		await withDb(async (db) => {
			await rebuildFtsIndexes(db);
		});
		const elapsed = Math.round(performance.now() - start);
		logger.info("FTS indexes rebuilt in {elapsed}ms", { elapsed });
	});

export const ftsCommand = new Command("fts")
	.description("Full-text search index management")
	.addCommand(rebuildCommand);
