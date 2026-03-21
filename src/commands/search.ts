import { Command } from "commander";
import { close, getDb } from "../db/index";
import { searchContent } from "../db/queries";

export const searchCommand = new Command("search")
	.description("Search across session summaries, research, and messages")
	.argument("<query>", "Search query")
	.option(
		"--in <scope>",
		"Search scope (summaries, research, messages, all)",
		"summaries",
	)
	.option("--json", "Output as JSON")
	.action(async (query, opts) => {
		const db = await getDb();
		try {
			const results = await searchContent(db, query, opts.in);

			if (opts.json) {
				console.log(JSON.stringify(results, null, 2));
			} else {
				if (results.length === 0) {
					console.log("No results found.");
					return;
				}
				for (const r of results) {
					console.log(`[${r.source_type}] ${r.id}`);
					console.log(`  ${r.snippet.slice(0, 120)}`);
					console.log();
				}
			}
		} finally {
			await close();
		}
	});
