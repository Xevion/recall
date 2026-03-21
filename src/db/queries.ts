import type { DuckDBConnection } from "@duckdb/node-api";
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
		conditions.push("s.project_name ILIKE ?");
		params.push(`%${opts.project}%`);
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
		conditions.push("s.project_name ILIKE ?");
		params.push(`%${opts.project}%`);
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
