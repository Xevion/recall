import { Command } from "commander";
import { withDb } from "../db/index";
import type { SearchMode, SearchResult } from "../db/queries";
import { searchContent } from "../db/queries";
import { c } from "../utils/theme";
import { resolveEnumOption } from "../utils/validation";

const VALID_SCOPES = ["summaries", "research", "messages", "all"] as const;
const VALID_MODES = ["fts", "like", "auto"] as const;

function normalizeScore(results: SearchResult[]): SearchResult[] {
	const scores = results.map((r) => r.score).filter((s) => s != null);
	if (scores.length === 0) return results;
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const range = max - min;
	if (range === 0) {
		return results.map((r) => ({
			...r,
			score: r.score != null ? 100 : null,
		}));
	}
	// BM25 in DuckDB: lower = more relevant
	return results.map((r) => ({
		...r,
		score: r.score != null ? Math.round(((max - r.score) / range) * 100) : null,
	}));
}

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
			const results = normalizeScore(raw);

			if (opts.json) {
				console.log(JSON.stringify(results, null, 2));
			} else {
				if (results.length === 0) {
					console.log("No results found.");
					return;
				}
				for (const r of results) {
					const scoreStr = r.score != null ? c.catGreen(` ${r.score}%`) : "";
					console.log(
						`${c.overlay1(`[${r.source_type}]`)} ${c.subtext0(r.id)}${scoreStr}`,
					);
					console.log(`  ${r.snippet.slice(0, 120)}`);
					console.log();
				}
			}
		});
	});
