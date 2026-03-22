import type { DuckDBConnection } from "@duckdb/node-api";

async function enumExists(
	conn: DuckDBConnection,
	name: string,
): Promise<boolean> {
	const reader = await conn.runAndReadAll(
		"SELECT type_name FROM duckdb_types() WHERE type_name = $name",
		{ name },
	);
	return reader.currentRowCount > 0;
}

export async function initSchema(conn: DuckDBConnection): Promise<void> {
	await conn.run("INSTALL fts");
	await conn.run("LOAD fts");

	// DuckDB does not support CREATE TYPE IF NOT EXISTS — check catalog first.
	if (!(await enumExists(conn, "source_type"))) {
		await conn.run(
			"CREATE TYPE source_type AS ENUM ('claude-code', 'opencode', 'cursor', 'other')",
		);
	}
	if (!(await enumExists(conn, "analysis_status"))) {
		await conn.run(
			"CREATE TYPE analysis_status AS ENUM ('pending', 'processing', 'complete', 'skipped', 'error', 'refused', 'retry_pending')",
		);
	}

	await conn.run(`
		CREATE TABLE IF NOT EXISTS session (
			id            TEXT PRIMARY KEY,
			source        source_type NOT NULL,
			parent_id     TEXT,
			project_path  TEXT,
			project_name  TEXT,
			git_branch    TEXT,
			title         TEXT,
			started_at    TIMESTAMPTZ NOT NULL,
			ended_at      TIMESTAMPTZ,
			message_count INT,
			turn_count    INT,
			token_input   BIGINT,
			token_output  BIGINT,
			duration_s    INT,
			source_path   TEXT,
			ingested_at   TIMESTAMPTZ DEFAULT now()
		)
	`);

	await conn.run(`
		CREATE TABLE IF NOT EXISTS message (
			id           TEXT PRIMARY KEY,
			session_id   TEXT NOT NULL REFERENCES session(id),
			role         TEXT NOT NULL,
			model        TEXT,
			seq          INT NOT NULL,
			timestamp    TIMESTAMPTZ,
			token_input  INT,
			token_output INT,
			content      TEXT,
			has_tool_use BOOLEAN DEFAULT FALSE
		)
	`);

	await conn.run(`
		CREATE TABLE IF NOT EXISTS tool_call (
			id            TEXT PRIMARY KEY,
			message_id    TEXT NOT NULL REFERENCES message(id),
			session_id    TEXT NOT NULL REFERENCES session(id),
			tool_name     TEXT NOT NULL,
			input_summary TEXT,
			is_error      BOOLEAN DEFAULT FALSE,
			duration_ms   INT
		)
	`);

	await conn.run(`
		CREATE TABLE IF NOT EXISTS subagent (
			session_id   TEXT PRIMARY KEY REFERENCES session(id),
			agent_type   TEXT,
			description  TEXT,
			slug         TEXT,
			prompt       TEXT,
			result       TEXT
		)
	`);

	await conn.run(`
		CREATE TABLE IF NOT EXISTS analysis (
			session_id         TEXT PRIMARY KEY REFERENCES session(id),
			status             analysis_status NOT NULL DEFAULT 'pending',
			title              TEXT,
			summary            TEXT,
			outcome            TEXT,
			outcome_confidence TEXT,
			session_types      TEXT[],
			topics             TEXT[],
			frustrations       JSON,
			actionable_insight TEXT,
			error_reason       TEXT,
			retry_count        INT DEFAULT 0,
			analyzed_at        TIMESTAMPTZ,
			analyzer_model     TEXT
		)
	`);

	await conn.run(`
		CREATE TABLE IF NOT EXISTS research_artifact (
			id                TEXT PRIMARY KEY,
			session_id        TEXT NOT NULL REFERENCES session(id),
			parent_session_id TEXT,
			topic             TEXT NOT NULL,
			content           TEXT NOT NULL,
			tags              TEXT[],
			created_at        TIMESTAMPTZ
		)
	`);

	await conn.run(`
		CREATE TABLE IF NOT EXISTS ingest_log (
			source_path TEXT PRIMARY KEY,
			source      source_type NOT NULL,
			file_mtime  TIMESTAMPTZ,
			file_hash   TEXT,
			session_id  TEXT,
			ingested_at TIMESTAMPTZ DEFAULT now()
		)
	`);
}
