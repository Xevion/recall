import type { DuckDBConnection } from "@duckdb/node-api";
import { extractProjectName } from "../utils/path";
import { ValidationError } from "../utils/validation";
import { ftsIndexesExist } from "./fts";
import { all } from "./index";

export type SearchMode = "fts" | "like" | "auto";

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
	session_types: string[] | null;
	outcome: string | null;
	outcome_confidence: string | null;
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

export function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, "\\$&");
}

export async function listSessions(
	db: DuckDBConnection,
	opts: ListSessionsOpts,
): Promise<SessionRow[]> {
	const conditions: string[] = ["s.parent_id IS NULL"];
	const params: unknown[] = [];

	if (opts.project) {
		const escaped = escapeLike(opts.project);
		conditions.push(
			"(s.project_name ILIKE ? ESCAPE '\\' OR s.project_path ILIKE ? ESCAPE '\\')",
		);
		params.push(`%${escaped}%`, `%${escaped}%`);
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

	const where = `WHERE ${conditions.join(" AND ")}`;
	const limit = opts.limit ?? 20;

	const sortCol = SORT_COLUMNS[opts.sortBy ?? "started"] ?? "s.started_at";
	const sortDir = opts.sortDir ?? "desc";

	return all<SessionRow>(
		db,
		`SELECT s.id, s.source, s.parent_id, s.project_path, s.project_name,
		        s.title, s.started_at, s.ended_at,
		        s.message_count, s.turn_count, s.token_input, s.token_output,
		        s.duration_s, a.status AS analysis_status, a.summary,
		        a.session_types, a.outcome, a.outcome_confidence
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
 * - 2-5 matches: throws listing them
 * - 6+ matches: throws asking to be more specific
 * - No matches: throws error
 */
export async function resolveSessionId(
	db: DuckDBConnection,
	partial: string,
): Promise<string> {
	// Try exact match first
	const exact = await all<{ id: string }>(
		db,
		"SELECT id FROM session WHERE id = ?",
		partial,
	);
	if (exact.length === 1) return (exact[0] as { id: string }).id;

	// Prefix match
	const matches = await all<{ id: string; source: string; started_at: string }>(
		db,
		"SELECT id, source, started_at FROM session WHERE id LIKE ? ORDER BY started_at DESC LIMIT 6",
		`${partial}%`,
	);

	if (matches.length === 0) {
		throw new ValidationError(`No session found matching: ${partial}`);
	}

	if (matches.length === 1) return (matches[0] as { id: string }).id;

	if (matches.length <= 5) {
		const lines = matches.map((m) => `  ${m.id}  ${m.source}  ${m.started_at}`);
		throw new ValidationError(
			`Ambiguous session ID "${partial}" — ${matches.length} matches:\n${lines.join("\n")}`,
		);
	}

	throw new ValidationError(
		`Ambiguous session ID "${partial}" — too many matches (6+). Be more specific.`,
	);
}

export interface ToolStatRow {
	tool_name: string;
	call_count: number;
	error_count: number;
	avg_duration_ms: number | null;
	error_rate: number;
}

export async function getToolStats(
	db: DuckDBConnection,
	opts: {
		since?: string;
		project?: string;
		sort?: "frequency" | "errors" | "duration";
	},
): Promise<ToolStatRow[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (opts.since) {
		conditions.push("s.started_at >= ?");
		params.push(opts.since);
	}
	if (opts.project) {
		const escaped = escapeLike(opts.project);
		conditions.push(
			"(s.project_name ILIKE ? ESCAPE '\\' OR s.project_path ILIKE ? ESCAPE '\\')",
		);
		params.push(`%${escaped}%`, `%${escaped}%`);
	}

	const where =
		conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const orderBy = {
		frequency: "call_count DESC",
		errors: "error_count DESC",
		duration: "avg_duration_ms DESC",
	}[opts.sort ?? "frequency"];

	return all<ToolStatRow>(
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

export interface SearchResult {
	source_type: string;
	id: string;
	snippet: string;
	context: string;
	score: number | null;
}

async function resolveSearchMode(
	db: DuckDBConnection,
	mode: SearchMode,
): Promise<"fts" | "like"> {
	if (mode === "fts") return "fts";
	if (mode === "like") return "like";
	return (await ftsIndexesExist(db)) ? "fts" : "like";
}

export async function searchContent(
	db: DuckDBConnection,
	query: string,
	scope: "summaries" | "research" | "messages" | "all" = "summaries",
	mode: SearchMode = "auto",
): Promise<SearchResult[]> {
	const resolved = await resolveSearchMode(db, mode);
	const results: SearchResult[] = [];

	if (scope === "summaries" || scope === "all") {
		if (resolved === "fts") {
			const rows = await all<{
				session_id: string;
				summary: string;
				score: number;
			}>(
				db,
				`SELECT session_id, summary, score
				 FROM (SELECT *, fts_main_analysis.match_bm25(session_id, ?) AS score FROM analysis)
				 WHERE score IS NOT NULL AND status = 'complete'
				 ORDER BY score
				 LIMIT 20`,
				query,
			);
			for (const row of rows) {
				results.push({
					source_type: "summary",
					id: row.session_id,
					snippet: row.summary,
					context: "analysis",
					score: row.score,
				});
			}
		} else {
			const pattern = `%${escapeLike(query)}%`;
			const rows = await all<{ session_id: string; summary: string }>(
				db,
				`SELECT session_id, summary FROM analysis
				 WHERE summary ILIKE ? ESCAPE '\\' AND status = 'complete'
				 LIMIT 20`,
				pattern,
			);
			for (const row of rows) {
				results.push({
					source_type: "summary",
					id: row.session_id,
					snippet: row.summary,
					context: "analysis",
					score: null,
				});
			}
		}
	}

	if (scope === "research" || scope === "all") {
		if (resolved === "fts") {
			const rows = await all<{
				id: string;
				topic: string;
				content: string;
				score: number;
			}>(
				db,
				`SELECT id, topic, content, score
				 FROM (SELECT *, fts_main_research_artifact.match_bm25(id, ?) AS score FROM research_artifact)
				 WHERE score IS NOT NULL
				 ORDER BY score
				 LIMIT 20`,
				query,
			);
			for (const row of rows) {
				results.push({
					source_type: "research",
					id: row.id,
					snippet: row.topic,
					context: row.content.slice(0, 200),
					score: row.score,
				});
			}
		} else {
			const pattern = `%${escapeLike(query)}%`;
			const rows = await all<{ id: string; topic: string; content: string }>(
				db,
				`SELECT id, topic, content FROM research_artifact
				 WHERE content ILIKE ? ESCAPE '\\' OR topic ILIKE ? ESCAPE '\\'
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
					score: null,
				});
			}
		}
	}

	if (scope === "messages" || scope === "all") {
		if (resolved === "fts") {
			const rows = await all<{
				id: string;
				session_id: string;
				content: string;
				score: number;
			}>(
				db,
				`SELECT id, session_id, content, score
				 FROM (SELECT *, fts_main_message.match_bm25(id, ?) AS score FROM message)
				 WHERE score IS NOT NULL
				 ORDER BY score
				 LIMIT 20`,
				query,
			);
			for (const row of rows) {
				results.push({
					source_type: "message",
					id: row.session_id,
					snippet: row.content.slice(0, 200),
					context: `message ${row.id}`,
					score: row.score,
				});
			}
		} else {
			const pattern = `%${escapeLike(query)}%`;
			const rows = await all<{
				id: string;
				session_id: string;
				content: string;
			}>(
				db,
				`SELECT id, session_id, content FROM message
				 WHERE content ILIKE ? ESCAPE '\\'
				 LIMIT 20`,
				pattern,
			);
			for (const row of rows) {
				results.push({
					source_type: "message",
					id: row.session_id,
					snippet: row.content.slice(0, 200),
					context: `message ${row.id}`,
					score: null,
				});
			}
		}
	}

	return results;
}

export interface SessionSearchRow extends SessionRow {
	relevance: number;
}

export async function searchSessions(
	db: DuckDBConnection,
	query: string,
	opts: ListSessionsOpts & { mode?: SearchMode },
): Promise<SessionSearchRow[]> {
	const resolved = await resolveSearchMode(db, opts.mode ?? "auto");
	const limit = opts.limit ?? 20;

	if (resolved === "like") {
		const pattern = `%${escapeLike(query)}%`;
		return all<SessionSearchRow>(
			db,
			`SELECT s.id, s.source, s.parent_id, s.project_path, s.project_name,
			        s.title, s.started_at, s.ended_at,
			        s.message_count, s.turn_count, s.token_input, s.token_output,
			        s.duration_s, a.status AS analysis_status, a.summary,
			        a.session_types, a.outcome, a.outcome_confidence,
			        0.0 AS relevance
			 FROM session s
			 LEFT JOIN analysis a ON a.session_id = s.id
			 WHERE s.parent_id IS NULL
			   AND (a.summary ILIKE ? ESCAPE '\\' OR EXISTS (
			     SELECT 1 FROM message m WHERE m.session_id = s.id AND m.content ILIKE ? ESCAPE '\\'
			   ))
			 ORDER BY s.started_at DESC
			 LIMIT ?`,
			pattern,
			pattern,
			limit,
		);
	}

	// FTS: search messages + analysis, aggregate best score per session
	// Lower BM25 = more relevant in DuckDB's implementation
	const conditions: string[] = ["s.parent_id IS NULL"];
	const filterParams: unknown[] = [];

	if (opts.project) {
		const escaped = escapeLike(opts.project);
		conditions.push(
			"(s.project_name ILIKE ? ESCAPE '\\' OR s.project_path ILIKE ? ESCAPE '\\')",
		);
		filterParams.push(`%${escaped}%`, `%${escaped}%`);
	}
	if (opts.source) {
		conditions.push("s.source = ?");
		filterParams.push(opts.source);
	}
	if (opts.since) {
		conditions.push("s.started_at >= ?");
		filterParams.push(opts.since);
	}
	if (opts.status) {
		conditions.push("a.status = ?");
		filterParams.push(opts.status);
	}
	if (opts.minTurns != null) {
		conditions.push("s.turn_count >= ?");
		filterParams.push(opts.minTurns);
	}
	if (opts.minDuration != null) {
		conditions.push("s.duration_s >= ?");
		filterParams.push(opts.minDuration);
	}
	if (opts.minMessages != null) {
		conditions.push("s.message_count >= ?");
		filterParams.push(opts.minMessages);
	}

	const where = `WHERE ${conditions.join(" AND ")}`;

	// Determine sort: if sortBy is explicitly given, use it; otherwise sort by relevance
	let orderClause: string;
	if (opts.sortBy && SORT_COLUMNS[opts.sortBy]) {
		const sortCol = SORT_COLUMNS[opts.sortBy];
		const sortDir = opts.sortDir ?? "desc";
		orderClause = `ORDER BY ${sortCol} ${sortDir} NULLS LAST`;
	} else {
		orderClause = "ORDER BY relevance";
	}

	return all<SessionSearchRow>(
		db,
		`WITH msg_scores AS (
			SELECT session_id, MIN(score) as best_score
			FROM (SELECT *, fts_main_message.match_bm25(id, ?) AS score FROM message)
			WHERE score IS NOT NULL
			GROUP BY session_id
		),
		analysis_scores AS (
			SELECT session_id, score as best_score
			FROM (SELECT *, fts_main_analysis.match_bm25(session_id, ?) AS score FROM analysis)
			WHERE score IS NOT NULL
		),
		combined AS (
			SELECT
				COALESCE(m.session_id, a.session_id) as session_id,
				LEAST(COALESCE(m.best_score, 1), COALESCE(a.best_score, 1)) as relevance
			FROM msg_scores m
			FULL OUTER JOIN analysis_scores a ON m.session_id = a.session_id
		)
		SELECT s.id, s.source, s.parent_id, s.project_path, s.project_name,
		       s.title, s.started_at, s.ended_at,
		       s.message_count, s.turn_count, s.token_input, s.token_output,
		       s.duration_s, a.status AS analysis_status, a.summary,
		       a.session_types, a.outcome, a.outcome_confidence,
		       c.relevance
		FROM combined c
		JOIN session s ON c.session_id = s.id
		LEFT JOIN analysis a ON a.session_id = s.id
		${where}
		${orderClause}
		LIMIT ?`,
		query,
		query,
		...filterParams,
		limit,
	);
}

/**
 * Get distinct human-readable project names from all sessions.
 * Used for "did you mean?" suggestions when --project matches nothing.
 */
export interface ContextSession {
	id: string;
	title: string | null;
	summary: string | null;
	outcome: string | null;
	outcome_confidence: string | null;
	session_types: string[] | null;
	topics: string[] | null;
	frustrations: { category: string; description: string; severity: string }[];
	actionable_insight: string | null;
	started_at: string;
	duration_s: number;
	turn_count: number;
	message_count: number;
}

export interface ProjectContext {
	project: string;
	generated_at: string;
	session_count: number;
	sessions: ContextSession[];
	topic_frequency: Record<string, number>;
	unanalyzed_count: number;
}

export interface GetProjectContextOpts {
	project: string;
	since?: string;
	limit?: number;
}

function parseFrustrations(
	raw: unknown,
): { category: string; description: string; severity: string }[] {
	if (raw == null) return [];
	try {
		const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (Array.isArray(parsed)) return parsed;
		return [];
	} catch {
		return [];
	}
}

export async function getProjectContext(
	db: DuckDBConnection,
	opts: GetProjectContextOpts,
): Promise<ProjectContext> {
	const conditions: string[] = ["s.parent_id IS NULL", "a.status = 'complete'"];
	const params: unknown[] = [];

	const escaped = escapeLike(opts.project);
	conditions.push(
		"(s.project_name ILIKE ? ESCAPE '\\' OR s.project_path ILIKE ? ESCAPE '\\')",
	);
	params.push(`%${escaped}%`, `%${escaped}%`);

	if (opts.since) {
		conditions.push("s.started_at >= ?");
		params.push(opts.since);
	}

	const limit = opts.limit ?? 10;
	const where = `WHERE ${conditions.join(" AND ")}`;

	const rows = await all<{
		id: string;
		title: string | null;
		summary: string | null;
		outcome: string | null;
		outcome_confidence: string | null;
		session_types: string[] | null;
		topics: string[] | null;
		frustrations: unknown;
		actionable_insight: string | null;
		started_at: string;
		duration_s: number;
		turn_count: number;
		message_count: number;
	}>(
		db,
		`SELECT s.id, a.title, a.summary, a.outcome, a.outcome_confidence,
		        a.session_types, a.topics, a.frustrations, a.actionable_insight,
		        s.started_at, s.duration_s, s.turn_count, s.message_count
		 FROM session s
		 JOIN analysis a ON a.session_id = s.id
		 ${where}
		 ORDER BY s.started_at DESC
		 LIMIT ?`,
		...params,
		limit,
	);

	const sessions: ContextSession[] = rows.map((row) => ({
		...row,
		frustrations: parseFrustrations(row.frustrations),
	}));

	const topicFrequency: Record<string, number> = {};
	for (const session of sessions) {
		if (session.topics) {
			for (const topic of session.topics) {
				topicFrequency[topic] = (topicFrequency[topic] ?? 0) + 1;
			}
		}
	}

	// Count unanalyzed sessions for the same project/since filters
	const unanalyzedConditions: string[] = [
		"s.parent_id IS NULL",
		"a.status IN ('pending', 'retry_pending')",
	];
	const unanalyzedParams: unknown[] = [];

	unanalyzedConditions.push(
		"(s.project_name ILIKE ? ESCAPE '\\' OR s.project_path ILIKE ? ESCAPE '\\')",
	);
	unanalyzedParams.push(`%${escaped}%`, `%${escaped}%`);

	if (opts.since) {
		unanalyzedConditions.push("s.started_at >= ?");
		unanalyzedParams.push(opts.since);
	}

	const unanalyzedWhere = `WHERE ${unanalyzedConditions.join(" AND ")}`;
	const unanalyzedRows = await all<{ cnt: number }>(
		db,
		`SELECT COUNT(*) as cnt
		 FROM session s
		 JOIN analysis a ON a.session_id = s.id
		 ${unanalyzedWhere}`,
		...unanalyzedParams,
	);
	const unanalyzedCount = Number(unanalyzedRows[0]?.cnt ?? 0);

	return {
		project: opts.project,
		generated_at: new Date().toISOString(),
		session_count: sessions.length,
		sessions,
		topic_frequency: topicFrequency,
		unanalyzed_count: unanalyzedCount,
	};
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
