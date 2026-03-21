import { Command } from "commander";
import { ftsIndexesExist } from "../db/fts";
import { all, withDb } from "../db/index";
import { escapeLike, getAvailableProjects } from "../db/queries";
import { extractProjectName } from "../utils/path";
import { c } from "../utils/theme";
import { parseRelativeDate, suggestProject } from "../utils/validation";

export const frustrationsCommand = new Command("frustrations")
	.description("Show detected frustrations and pain points")
	.option("-q, --query <text>", "Search frustrations and summaries")
	.option("--since <date>", "Filter by date")
	.option("-p, --project <name>", "Filter by project")
	.option("--include-refused", "Include sessions where analysis was refused")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const since = opts.since ? parseRelativeDate(opts.since) : undefined;

		await withDb(async (db) => {
			const conditions = [
				opts.includeRefused
					? "a.status IN ('complete', 'refused')"
					: "a.status = 'complete'",
				"array_length(a.frustrations) > 0",
			];
			const params: unknown[] = [];

			if (since) {
				conditions.push("s.started_at >= ?");
				params.push(since);
			}
			if (opts.project) {
				const escaped = escapeLike(opts.project);
				conditions.push(
					"(s.project_name ILIKE ? ESCAPE '\\' OR s.project_path ILIKE ? ESCAPE '\\')",
				);
				params.push(`%${escaped}%`, `%${escaped}%`);
			}

			let sql: string;

			if (opts.query) {
				const hasFts = await ftsIndexesExist(db);
				if (hasFts) {
					// FTS on analysis summary/workflow_notes, filtered to sessions with frustrations
					sql = `
						SELECT s.id, s.project_path, s.project_name, s.started_at, a.frustrations, a.summary
						FROM (SELECT *, fts_main_analysis.match_bm25(session_id, ?) AS score FROM analysis) a
						JOIN session s ON a.session_id = s.id
						WHERE score IS NOT NULL AND ${conditions.join(" AND ")}
						ORDER BY score
						LIMIT 50`;
					params.unshift(opts.query);
				} else {
					const pattern = `%${escapeLike(opts.query)}%`;
					conditions.push(
						"(a.summary ILIKE ? ESCAPE '\\' OR a.workflow_notes ILIKE ? ESCAPE '\\')",
					);
					params.push(pattern, pattern);
					sql = `
						SELECT s.id, s.project_path, s.project_name, s.started_at, a.frustrations, a.summary
						FROM analysis a
						JOIN session s ON a.session_id = s.id
						WHERE ${conditions.join(" AND ")}
						ORDER BY s.started_at DESC
						LIMIT 50`;
				}
			} else {
				sql = `
					SELECT s.id, s.project_path, s.project_name, s.started_at, a.frustrations, a.summary
					FROM analysis a
					JOIN session s ON a.session_id = s.id
					WHERE ${conditions.join(" AND ")}
					ORDER BY s.started_at DESC
					LIMIT 50`;
			}

			const results = await all<{
				id: string;
				project_path: string | null;
				project_name: string | null;
				started_at: string;
				frustrations: string[];
				summary: string;
			}>(db, sql, ...params);

			if (opts.json) {
				console.log(JSON.stringify(results, null, 2));
			} else {
				if (results.length === 0) {
					console.log("No frustrations detected.");
					if (opts.project) {
						const available = await getAvailableProjects(db);
						const suggestions = suggestProject(opts.project, available);
						if (suggestions.length > 0) {
							console.log(
								c.overlay1(`Did you mean: ${suggestions.join(", ")}?`),
							);
						}
					}
					return;
				}
				for (const r of results) {
					const projectDisplay =
						extractProjectName(r.project_path) ?? r.project_name ?? "unknown";
					console.log(
						`${projectDisplay} — ${new Date(r.started_at).toLocaleDateString()}`,
					);
					console.log(`  ${r.summary?.slice(0, 100) ?? ""}`);
					for (const f of r.frustrations ?? []) {
						console.log(`  ! ${f}`);
					}
					console.log();
				}
			}
		});
	});
