import { Command } from "commander";
import { rebuildFtsIndexes } from "../db/fts";
import { withDb } from "../db/index";

const rebuildCommand = new Command("rebuild")
	.description("Rebuild all full-text search indexes")
	.action(async () => {
		const start = performance.now();
		await withDb(async (db) => {
			await rebuildFtsIndexes(db);
		});
		const elapsed = Math.round(performance.now() - start);
		console.log(`FTS indexes rebuilt in ${elapsed}ms`);
	});

export const ftsCommand = new Command("fts")
	.description("Full-text search index management")
	.addCommand(rebuildCommand);
