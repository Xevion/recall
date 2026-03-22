import { Command } from "commander";
import { withDb } from "../db/index";
import type { SearchMode, SearchResult } from "../db/queries";
import { searchContent } from "../db/queries";
import { normalizeScores, printFooter } from "../utils/table";
import { c } from "../utils/theme";
import { resolveEnumOption } from "../utils/validation";

const VALID_SCOPES = ["summaries", "research", "messages", "all"] as const;
const VALID_MODES = ["fts", "like", "auto"] as const;

export const searchCommand = new Command("search")
	.description("Search across session summaries, research, and messages")
	.argument("<query>", "Search query")
	.option(
		"--in <scope>",
		"Search scope (summaries, research, messages, all)",
		"summaries",
	)
	.option("--mode <mode>", "Search mode (fts, like, auto)", "auto")
	.option("--json", "Output as JSON")
	.action(async (query, opts) => {
		const scope = resolveEnumOption(opts.in, VALID_SCOPES, "in");
		const mode = resolveEnumOption(
			opts.mode,
			VALID_MODES,
			"mode",
		) as SearchMode;

		await withDb(async (db) => {
			const raw = await searchContent(db, query, scope, mode);
			const scoreMap = normalizeScores(raw);

			if (opts.json) {
				console.log(JSON.stringify(raw, null, 2));
			} else {
				if (raw.length === 0) {
					console.log(c.overlay0("No results found."));
					return;
				}
				for (const r of raw) {
					const pct = scoreMap.get(r.id);
					const scoreStr = pct != null ? ` ${c.catGreen(`${pct}%`)}` : "";
					console.log(
						`${c.overlay1(`[${r.source_type}]`)} ${c.subtext0(r.id)}${scoreStr}`,
					);
					console.log(`  ${c.text(r.snippet.slice(0, 120))}`);
					console.log();
				}
				printFooter(raw.length, "result");
			}
		});
	});
