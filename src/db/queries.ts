import type { DuckDBConnection } from "@duckdb/node-api";
import { extractProjectName } from "../utils/path";
import { all } from "./index";

export interface SessionRow {
	id: string;
	source: string;
	parent_id: string | null;
	project_path: string | null;
	project_name: string | null;
	title: string | null;
	started_at: string;
	ended_at: string | null;
	message_count: number;
	turn_count: number;
	token_input: number;
	token_output: number;
	duration_s: number;
	analysis_status: string | null;
	summary: string | null;
}

const SORT_COLUMNS: Record<string, string> = {
	started: "s.started_at",
	duration: "s.duration_s",
	turns: "s.turn_count",
	messages: "s.message_count",
};

export interface ListSessionsOpts {
	project?: string;
	source?: string;
	since?: string;
	limit?: number;
	status?: string;
	minTurns?: number;
	minDuration?: number;
	minMessages?: number;
	sortBy?: string;
	sortDir?: "asc" | "desc";
}

export async function listSessions(
	db: DuckDBConnection,
	opts: ListSessionsOpts,
): Promise<SessionRow[]> {
	const conditions: string[] = ["s.parent_id IS NULL"];
	const params: unknown[] = [];

	if (opts.project) {
		conditions.push("(s.project_name ILIKE ? OR s.project_path ILIKE ?)");
		params.push(`%${opts.project}%`, `%${opts.project}%`);
	}
	if (opts.source) {
		conditions.push("s.source = ?");
		params.push(opts.source);
	}
	if (opts.since) {
		conditions.push("s.started_at >= ?");
		params.push(opts.since);
	}
	if (opts.status) {
		conditions.push("a.status = ?");
		params.push(opts.status);
	}
	if (opts.minTurns != null) {
		conditions.push("s.turn_count >= ?");
		params.push(opts.minTurns);
	}
	if (opts.minDuration != null) {
		conditions.push("s.duration_s >= ?");
		params.push(opts.minDuration);
	}
	if (opts.minMessages != null) {
		conditions.push("s.message_count >= ?");
		params.push(opts.minMessages);
	}

	const where =
		conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = opts.limit ?? 20;

	const sortCol = SORT_COLUMNS[opts.sortBy ?? "started"] ?? "s.started_at";
	const sortDir = opts.sortDir ?? "desc";

	return all<SessionRow>(
		db,
		`SELECT s.id, s.source, s.parent_id, s.project_path, s.project_name,
		        s.title, s.started_at, s.ended_at,
		        s.message_count, s.turn_count, s.token_input, s.token_output,
		        s.duration_s, a.status AS analysis_status, a.summary
		 FROM session s
		 LEFT JOIN analysis a ON a.session_id = s.id
		 ${where}
		 ORDER BY ${sortCol} ${sortDir} NULLS LAST
		 LIMIT ?`,
		...params,
		limit,
	);
}

/**
 * Resolve a partial session ID to a full one.
 * - Exact match: returns immediately
 * - Single prefix match: returns that session's ID
 * - 2-5 matches: prints them and exits
 * - 6+ matches: prints the count and exits
 * - No matches: prints error and exits
 */
export async function resolveSessionId(
	db: DuckDBConnection,
	partial: string,
): Promise<string | null> {
	// Try exact match first
	const exact = await all<{ id: string }>(
		db,
		"SELECT id FROM session WHERE id = ?",
		partial,
	);
	if (exact.length === 1) return exact[0]!.id;

	// Prefix match
	const matches = await all<{ id: string; source: string; started_at: string }>(
		db,
		"SELECT id, source, started_at FROM session WHERE id LIKE ? ORDER BY started_at DESC LIMIT 6",
		`${partial}%`,
	);

	if (matches.length === 0) {
		console.error(`No session found matching: ${partial}`);
		process.exit(1);
	}

	if (matches.length === 1) return matches[0]!.id;

	if (matches.length <= 5) {
		console.error(
			`Ambiguous session ID "${partial}" — ${matches.length} matches:`,
		);
		for (const m of matches) {
			console.error(`  ${m.id}  ${m.source}  ${m.started_at}`);
		}
		process.exit(1);
	}

	// 6+ means our LIMIT 6 query was full — could be even more
	console.error(
		`Ambiguous session ID "${partial}" — too many matches (6+). Be more specific.`,
	);
	process.exit(1);
}

export async function getToolStats(
	db: DuckDBConnection,
	opts: {
		since?: string;
		project?: string;
		sort?: "frequency" | "errors" | "duration";
	},
) {
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (opts.since) {
		conditions.push("s.started_at >= ?");
		params.push(opts.since);
	}
	if (opts.project) {
		conditions.push("(s.project_name ILIKE ? OR s.project_path ILIKE ?)");
		params.push(`%${opts.project}%`, `%${opts.project}%`);
	}

	const where =
		conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const orderBy = {
		frequency: "call_count DESC",
		errors: "error_count DESC",
		duration: "avg_duration_ms DESC",
	}[opts.sort ?? "frequency"];

	return all(
		db,
		`SELECT
       tc.tool_name,
       COUNT(*) as call_count,
       SUM(CASE WHEN tc.is_error THEN 1 ELSE 0 END) as error_count,
       ROUND(AVG(tc.duration_ms), 0) as avg_duration_ms,
       ROUND(100.0 * SUM(CASE WHEN tc.is_error THEN 1 ELSE 0 END) / COUNT(*), 1) as error_rate
     FROM tool_call tc
     JOIN session s ON tc.session_id = s.id
     ${where}
     GROUP BY tc.tool_name
     ORDER BY ${orderBy}`,
		...params,
	);
}

export async function searchContent(
	db: DuckDBConnection,
	query: string,
	scope: "summaries" | "research" | "messages" | "all" = "summaries",
) {
	const results: Array<{
		source_type: string;
		id: string;
		snippet: string;
		context: string;
	}> = [];
	const pattern = `%${query}%`;

	if (scope === "summaries" || scope === "all") {
		const rows = await all<{ session_id: string; summary: string }>(
			db,
			`SELECT session_id, summary FROM analysis
       WHERE summary ILIKE ? AND status = 'complete'
       LIMIT 20`,
			pattern,
		);
		for (const row of rows) {
			results.push({
				source_type: "summary",
				id: row.session_id,
				snippet: row.summary,
				context: "analysis",
			});
		}
	}

	if (scope === "research" || scope === "all") {
		const rows = await all<{ id: string; topic: string; content: string }>(
			db,
			`SELECT id, topic, content FROM research_artifact
       WHERE content ILIKE ? OR topic ILIKE ?
       LIMIT 20`,
			pattern,
			pattern,
		);
		for (const row of rows) {
			results.push({
				source_type: "research",
				id: row.id,
				snippet: row.topic,
				context: row.content.slice(0, 200),
			});
		}
	}

	if (scope === "messages" || scope === "all") {
		const rows = await all<{ id: string; session_id: string; content: string }>(
			db,
			`SELECT id, session_id, content FROM message
       WHERE content ILIKE ?
       LIMIT 20`,
			pattern,
		);
		for (const row of rows) {
			results.push({
				source_type: "message",
				id: row.session_id,
				snippet: row.content.slice(0, 200),
				context: `message ${row.id}`,
			});
		}
	}

	return results;
}

/**
 * Get distinct human-readable project names from all sessions.
 * Used for "did you mean?" suggestions when --project matches nothing.
 */
export async function getAvailableProjects(
	db: DuckDBConnection,
): Promise<string[]> {
	const rows = await all<{ project_path: string }>(
		db,
		"SELECT DISTINCT project_path FROM session WHERE project_path IS NOT NULL AND parent_id IS NULL",
	);
	const names = new Set<string>();
	for (const row of rows) {
		const name = extractProjectName(row.project_path);
		if (name) names.add(name);
	}
	return [...names].sort();
}
