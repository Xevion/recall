import { Command } from "commander";
import { ftsIndexesExist } from "../db/fts";
import { all, withDb } from "../db/index";
import { escapeLike } from "../db/queries";
import { parseIntOption } from "../utils/validation";

interface ResearchRow {
	id: string;
	topic: string;
	tags: string[];
	created_at: string;
	content_length: number;
	score: number | null;
}

export const researchCommand = new Command("research")
	.description("Browse and search research artifacts")
	.option("--topic <query>", "Search by topic")
	.option("--tags <tag>", "Filter by tag")
	.option("--list", "List all research artifacts")
	.option("-l, --limit <n>", "Number of results", "20")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const limit = parseIntOption(opts.limit, "limit");

		await withDb(async (db) => {
			let results: ResearchRow[];

			if (opts.topic) {
				const hasFts = await ftsIndexesExist(db);
				if (hasFts) {
					results = await all<ResearchRow>(
						db,
						`SELECT id, topic, tags, created_at, length(content) as content_length, score
						 FROM (SELECT *, fts_main_research_artifact.match_bm25(id, ?) AS score FROM research_artifact)
						 WHERE score IS NOT NULL
						 ORDER BY score
						 LIMIT ?`,
						opts.topic,
						limit,
					);
				} else {
					const pattern = `%${escapeLike(opts.topic)}%`;
					results = await all<ResearchRow>(
						db,
						`SELECT id, topic, tags, created_at, length(content) as content_length, NULL as score
						 FROM research_artifact
						 WHERE topic ILIKE ? OR content ILIKE ?
						 ORDER BY created_at DESC LIMIT ?`,
						pattern,
						pattern,
						limit,
					);
				}
			} else if (opts.tags) {
				results = await all<ResearchRow>(
					db,
					`SELECT id, topic, tags, created_at, length(content) as content_length, NULL as score
           FROM research_artifact
           WHERE list_contains(tags, ?)
           ORDER BY created_at DESC LIMIT ?`,
					opts.tags,
					limit,
				);
			} else {
				results = await all<ResearchRow>(
					db,
					`SELECT id, topic, tags, created_at, length(content) as content_length, NULL as score
           FROM research_artifact
           ORDER BY created_at DESC LIMIT ?`,
					limit,
				);
			}

			if (opts.json) {
				console.log(JSON.stringify(results, null, 2));
			} else {
				if (results.length === 0) {
					console.log("No research artifacts found.");
					return;
				}
				for (const r of results) {
					console.log(`${r.id}`);
					console.log(`  Topic: ${r.topic}`);
					console.log(`  Tags: ${r.tags}`);
					console.log(`  Size: ${r.content_length} chars`);
					console.log();
				}
			}
		});
	});
