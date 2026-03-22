import { Command } from "commander";
import { ftsIndexesExist } from "../db/fts";
import { all, withDb } from "../db/index";
import { escapeLike, getAvailableProjects } from "../db/queries";
import { colorProject, colorStarted, projectDisplay } from "../utils/colors";
import { formatDate, termWidth, wordWrap } from "../utils/format";
import { printFooter } from "../utils/table";
import { c } from "../utils/theme";
import { parseRelativeDate, suggestProject } from "../utils/validation";

const CONTENT_INDENT = 2;
const BULLET_PREFIX = "! ";
const BULLET_WIDTH = BULLET_PREFIX.length;

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
				"a.frustrations IS NOT NULL AND json_array_length(a.frustrations) > 0",
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
						"(a.summary ILIKE ? ESCAPE '\\' OR a.actionable_insight ILIKE ? ESCAPE '\\')",
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

			interface FrustrationItem {
				category: string;
				description: string;
				severity: string;
			}

			const results = await all<{
				id: string;
				project_path: string | null;
				project_name: string | null;
				started_at: string;
				frustrations: string;
				summary: string;
			}>(db, sql, ...params);

			if (opts.json) {
				const parsed = results.map((r) => ({
					...r,
					frustrations: parseFrustrations(r.frustrations),
				}));
				console.log(JSON.stringify(parsed, null, 2));
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
				const cols = termWidth();
				const contentWidth = Math.max(20, cols - CONTENT_INDENT);
				const bulletContentWidth = Math.max(
					20,
					cols - CONTENT_INDENT - BULLET_WIDTH,
				);
				const indent = " ".repeat(CONTENT_INDENT);
				const bulletIndent = " ".repeat(CONTENT_INDENT + BULLET_WIDTH);

				for (const r of results) {
					const proj = projectDisplay(r);
					const date = formatDate(r.started_at);
					console.log(
						`${colorProject(proj)} ${c.overlay0("—")} ${colorStarted(r.started_at, date)} ${c.overlay0(r.id.slice(0, 14))}`,
					);
					if (r.summary) {
						const lines = wordWrap(r.summary, contentWidth);
						for (const line of lines) {
							console.log(`${indent}${c.subtext0(line)}`);
						}
					}
					const items = parseFrustrations(r.frustrations);
					for (const f of items) {
						const label = `[${f.severity}/${f.category}] ${f.description}`;
						const lines = wordWrap(label, bulletContentWidth);
						for (let i = 0; i < lines.length; i++) {
							const line = lines[i]!;
							if (i === 0) {
								console.log(
									`${indent}${c.catYellow(BULLET_PREFIX)}${c.text(line)}`,
								);
							} else {
								console.log(`${bulletIndent}${c.text(line)}`);
							}
						}
					}
					console.log();
				}
				printFooter(results.length, "session");
			}

			function parseFrustrations(raw: string | unknown): FrustrationItem[] {
				try {
					const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
					return Array.isArray(parsed) ? parsed : [];
				} catch {
					return [];
				}
			}
		});
	});
