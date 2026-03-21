import type duckdb from "duckdb";
import { run } from "./index";

const SCHEMA_SQL = `
CREATE TYPE IF NOT EXISTS source_type AS ENUM ('claude-code', 'opencode', 'cursor', 'other');

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
);

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
);

CREATE TABLE IF NOT EXISTS tool_call (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES message(id),
  session_id    TEXT NOT NULL REFERENCES session(id),
  tool_name     TEXT NOT NULL,
  input_summary TEXT,
  is_error      BOOLEAN DEFAULT FALSE,
  duration_ms   INT
);

CREATE TABLE IF NOT EXISTS subagent (
  session_id  TEXT PRIMARY KEY REFERENCES session(id),
  agent_type  TEXT,
  slug        TEXT,
  prompt      TEXT,
  result      TEXT
);

CREATE TABLE IF NOT EXISTS analysis (
  session_id     TEXT PRIMARY KEY REFERENCES session(id),
  status         TEXT NOT NULL DEFAULT 'pending',
  summary        TEXT,
  topics         TEXT[],
  frustrations   TEXT[],
  workflow_notes TEXT,
  error_reason   TEXT,
  retry_count    INT DEFAULT 0,
  analyzed_at    TIMESTAMPTZ,
  analyzer_model TEXT
);

CREATE TABLE IF NOT EXISTS research_artifact (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES session(id),
  parent_session_id TEXT,
  topic             TEXT NOT NULL,
  content           TEXT NOT NULL,
  tags              TEXT[],
  created_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ingest_log (
  source_path TEXT PRIMARY KEY,
  source      source_type NOT NULL,
  file_mtime  TIMESTAMPTZ,
  file_hash   TEXT,
  session_id  TEXT,
  ingested_at TIMESTAMPTZ DEFAULT now()
);
`;

export async function initSchema(db: duckdb.Database): Promise<void> {
	// DuckDB doesn't support multi-statement run, split by semicolons
	const statements = SCHEMA_SQL.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	for (const stmt of statements) {
		await run(db, stmt + ";");
	}
}
