import { Command } from "commander";
import { withDb } from "../db/index";
import { searchContent } from "../db/queries";
import { resolveEnumOption } from "../utils/validation";

const VALID_SCOPES = ["summaries", "research", "messages", "all"] as const;

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
		const scope = resolveEnumOption(opts.in, VALID_SCOPES, "in");

		await withDb(async (db) => {
			const results = await searchContent(db, query, scope);

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
		});
	});
