import Table from "cli-table3";
import { Command } from "commander";
import { all, withDb } from "../db/index";
import { formatDate, formatDuration, formatTokens } from "../utils/format";
import { extractProjectName } from "../utils/path";
import { BORDERLESS_CHARS, c } from "../utils/theme";
import { resolveEnumOption } from "../utils/validation";

const VALID_SORTS = ["recent", "sessions", "tokens"] as const;

export const projectsCommand = new Command("projects")
	.description("Project-level activity summary")
	.option("--sort <by>", "Sort by: recent, sessions, tokens", "recent")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const sort = resolveEnumOption(opts.sort, VALID_SORTS, "sort");

		await withDb(async (db) => {
			const orderBy = {
				recent: "last_active DESC",
				sessions: "session_count DESC",
				tokens: "total_tokens DESC",
			}[sort];

			const rows = await all<{
				project_path: string;
				session_count: number;
				total_tokens: number;
				total_duration_s: number;
				last_active: string;
				first_active: string;
			}>(
				db,
				`SELECT
           project_path,
           COUNT(*) as session_count,
           SUM(token_input + token_output) as total_tokens,
           SUM(duration_s) as total_duration_s,
           MAX(started_at) as last_active,
           MIN(started_at) as first_active
         FROM session
         WHERE project_path IS NOT NULL AND parent_id IS NULL
         GROUP BY project_path
         ORDER BY ${orderBy}`,
			);

			// Derive display names and merge rows that map to the same name
			const merged = new Map<
				string,
				{
					sessions: number;
					tokens: number;
					duration: number;
					lastActive: string;
				}
			>();
			for (const r of rows) {
				const name = extractProjectName(r.project_path) ?? r.project_path;
				const existing = merged.get(name);
				if (existing) {
					existing.sessions += r.session_count;
					existing.tokens += r.total_tokens;
					existing.duration += r.total_duration_s;
					if (r.last_active > existing.lastActive)
						existing.lastActive = r.last_active;
				} else {
					merged.set(name, {
						sessions: r.session_count,
						tokens: r.total_tokens,
						duration: r.total_duration_s,
						lastActive: r.last_active,
					});
				}
			}

			// Re-sort merged results
			const sortFn = {
				recent: (
					a: [string, { lastActive: string }],
					b: [string, { lastActive: string }],
				) => b[1].lastActive.localeCompare(a[1].lastActive),
				sessions: (
					a: [string, { sessions: number }],
					b: [string, { sessions: number }],
				) => b[1].sessions - a[1].sessions,
				tokens: (
					a: [string, { tokens: number }],
					b: [string, { tokens: number }],
				) => b[1].tokens - a[1].tokens,
			}[sort];

			const entries = [...merged.entries()];
			if (sortFn)
				entries.sort(
					sortFn as (a: [string, unknown], b: [string, unknown]) => number,
				);

			if (opts.json) {
				const jsonResults = entries.map(([name, data]) => ({
					project_name: name,
					session_count: data.sessions,
					total_tokens: data.tokens,
					total_duration_s: data.duration,
					last_active: data.lastActive,
				}));
				console.log(JSON.stringify(jsonResults, null, 2));
			} else {
				const table = new Table({
					head: [
						"Project",
						"Sessions",
						"Tokens",
						"Duration",
						"Last Active",
					].map((h) => c.text.bold(h)),
					colAligns: ["left", "right", "right", "right", "left"],
					colWidths: [30, 10, 10, 10, 14],
					style: {
						head: [],
						border: [],
						"padding-left": 0,
						"padding-right": 0,
					},
					chars: BORDERLESS_CHARS,
				});

				for (const [name, data] of entries) {
					table.push([
						c.catBlue(name),
						c.text(String(data.sessions)),
						c.subtext0(formatTokens(data.tokens)),
						c.overlay1(formatDuration(data.duration)),
						formatDate(data.lastActive),
					]);
				}

				console.log(table.toString());
				console.log(c.overlay1(`\n${entries.length} project(s)`));
			}
		});
	});
