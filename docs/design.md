# Recall — Design Document

**Date**: 2026-03-21
**Status**: Draft (revised)

## Purpose

Recall is a CLI tool for ingesting, analyzing, and querying AI coding assistant session data. It builds a long-term DuckDB database of sessions, tool usage, subagent dispatches, research artifacts, and AI-generated analysis — providing a queryable history of coding work across multiple AI assistants.

## Goals

1. **Session summary & querying** — search and browse past sessions by project, date, topic, or content
2. **Tool usage analysis** — identify best/worst tool patterns, workflow improvements
3. **Frustration detection** — surface repeated failures, backtracking, user corrections
4. **Research artifact persistence** — auto-extract research subagent output as findable, reusable artifacts
5. **AI-accessible history** — CLI interface that AI assistants can invoke to look back at past work
6. **Living memory** — long-term database of sessions, projects, and daily work patterns

## Architecture

### Two-Phase Pipeline

```
Phase 1: Ingest (structural)
  Source files → Parse → Normalize → DuckDB (in transactions)

Phase 2: Analyze (selective, AI-powered)
  Pending sessions → Triage → claude-agent-sdk query() → DuckDB
```

### Data Sources

| Source | Format | Location |
|---|---|---|
| Claude Code | JSONL files | `~/.claude/projects/<project-dir>/<session-uuid>.jsonl` |
| OpenCode | SQLite database | `~/.local/share/opencode/opencode.db` |
| Future sources | TBD | Configurable per-source |

### Tech Stack

- **Runtime**: Bun
- **Database**: DuckDB via `@duckdb/node-api` (native Promises, prepared statements)
- **AI Analysis**: `@anthropic-ai/claude-agent-sdk` with `query()` async generator
- **CLI Framework**: Commander
- **Config**: TOML via smol-toml
- **Formatting**: Biome
- **Testing**: `bun test`
- **Task Runner**: Just
- **Distribution**: `bun install -g` (native module prevents `bun build --compile`)

## DuckDB Schema

Schema initialization uses catalog checks for ENUM types (DuckDB does not support
`CREATE TYPE IF NOT EXISTS`). All ENUM types are checked against `duckdb_types()`
before creation. Tables use `CREATE TABLE IF NOT EXISTS`.

All session ingestion is wrapped in transactions for atomicity and performance.
Prepared statements are reused across loop iterations.

```sql
-- Check duckdb_types() before creating; DuckDB ENUMs cannot be altered after creation
CREATE TYPE source_type AS ENUM ('claude-code', 'opencode', 'cursor', 'other');

CREATE TYPE analysis_status AS ENUM (
  'pending', 'processing', 'complete',
  'skipped', 'error', 'refused', 'retry_pending'
);

-- Core session table
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

-- Individual messages
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

-- Tool calls extracted from assistant messages
CREATE TABLE IF NOT EXISTS tool_call (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES message(id),
  session_id    TEXT NOT NULL REFERENCES session(id),
  tool_name     TEXT NOT NULL,
  input_summary TEXT,
  is_error      BOOLEAN DEFAULT FALSE,
  duration_ms   INT
);

-- Subagent metadata (supplements session where parent_id IS NOT NULL)
CREATE TABLE IF NOT EXISTS subagent (
  session_id   TEXT PRIMARY KEY REFERENCES session(id),
  agent_type   TEXT,
  description  TEXT,
  slug         TEXT,
  prompt       TEXT,
  result       TEXT
);

-- AI-generated analysis
CREATE TABLE IF NOT EXISTS analysis (
  session_id     TEXT PRIMARY KEY REFERENCES session(id),
  status         analysis_status NOT NULL DEFAULT 'pending',
  summary        TEXT,
  topics         TEXT[],
  frustrations   TEXT[],
  workflow_notes TEXT,
  error_reason   TEXT,
  retry_count    INT DEFAULT 0,
  analyzed_at    TIMESTAMPTZ,
  analyzer_model TEXT
);

-- Research artifacts extracted from subagents
CREATE TABLE IF NOT EXISTS research_artifact (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES session(id),
  parent_session_id TEXT,
  topic             TEXT NOT NULL,
  content           TEXT NOT NULL,
  tags              TEXT[],
  created_at        TIMESTAMPTZ
);

-- Ingest bookkeeping (idempotency)
CREATE TABLE IF NOT EXISTS ingest_log (
  source_path TEXT PRIMARY KEY,
  source      source_type NOT NULL,
  file_mtime  TIMESTAMPTZ,
  file_hash   TEXT,
  session_id  TEXT,
  ingested_at TIMESTAMPTZ DEFAULT now()
);
```

## Claude Code JSONL Format

### Directory Layout

```
~/.claude/projects/
├── -home-xevion-projects-ferrite/              # cwd with non-alnum chars → '-'
│   ├── 9023bcb6-e89a-4407-a0d3-67d4548669c0.jsonl     # session transcript
│   ├── 9023bcb6-e89a-4407-a0d3-67d4548669c0/          # session data dir
│   │   ├── subagents/
│   │   │   ├── agent-a64ecb19e8594b80c.jsonl           # subagent transcript
│   │   │   └── agent-a64ecb19e8594b80c.meta.json       # {"agentType":"research","description":"..."}
│   │   └── tool-results/                               # large tool outputs stored separately
│   │       └── btxd54az9.txt
│   ├── another-session.jsonl
│   └── memory/                                         # Claude Code memory files
```

Session JSONL files are at the project directory level: `<project-dir>/<uuid>.jsonl`.
Subagent JSONL files are inside `<project-dir>/<uuid>/subagents/agent-<agentId>.jsonl`.
Each subagent has a companion `.meta.json` with `agentType` and `description`.

### JSONL Event Types

Each line is a JSON object with a `type` field:

| `type` | Purpose | Parse? |
|---|---|---|
| `user` | User messages (text or tool results) | Yes |
| `assistant` | Model responses (text, tool_use, thinking) | Yes |
| `system` | Hook summaries, init events | Metadata only |
| `progress` | Streaming/hook progress events (noisy) | Skip |
| `file-history-snapshot` | File version backups | Skip |
| `last-prompt` | Prompt metadata | Skip |
| `compact_boundary` | Context compaction marker | Skip |
| `summary` | Cross-session summaries | Skip |

### Common Top-Level Fields

Every event has these fields (from v2.1.x):

```json
{
  "type": "user",
  "uuid": "e2dbdfef-3699-4d96-8027-24a09d5cd58d",
  "parentUuid": null,
  "sessionId": "31f3f224-f440-41ac-9244-b27ff054116d",
  "timestamp": "2025-12-22T21:18:34.755Z",
  "cwd": "/home/xevion/projects/ferrite",
  "version": "2.1.80",
  "gitBranch": "master",
  "isSidechain": false,
  "userType": "external",
  "entrypoint": "cli",
  "slug": "tender-strolling-wigderson"
}
```

Notes:
- `gitBranch` is `""` (empty string) outside git repos, not `null`
- `sessionId` is NOT on every event type — `file-history-snapshot` lacks it
- `isSidechain: true` on all subagent events
- `agentId` present on subagent events (e.g., `"a64ecb19e8594b80c"`)
- `agentType` is NOT a JSONL field — only exists in companion `.meta.json`
- `isMeta: true` on system/hook-generated user messages (should be excluded from analysis)

### User Message Structure

Normal user prompt — `content` is a string:

```json
{
  "type": "user",
  "message": { "role": "user", "content": "Fix the login bug" }
}
```

Tool result delivery — `content` is an array:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "tool_use_id": "toolu_01ABC123",
      "content": "command output here",
      "is_error": false
    }]
  }
}
```

Tool errors are detected from `is_error: true` on `tool_result` blocks inside
user messages, NOT as separate top-level events.

### Assistant Message Structure

The `message` field is the full Anthropic API response:

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "model": "claude-sonnet-4-6",
    "id": "msg_014pGTytAzZprPytRNL7U8L6",
    "type": "message",
    "stop_reason": "end_turn",
    "content": [
      { "type": "text", "text": "I'll help you..." },
      { "type": "thinking", "thinking": "...", "signature": "hash" },
      { "type": "tool_use", "id": "toolu_01ABC", "name": "Bash", "input": {"command": "npm test"} }
    ],
    "usage": {
      "input_tokens": 8,
      "output_tokens": 500,
      "cache_creation_input_tokens": 6127,
      "cache_read_input_tokens": 53499
    }
  }
}
```

Known issue: streaming bug (#22686) causes some intermediate chunks to be recorded
with `output_tokens: 1` and `stop_reason: null`. Token aggregation should expect
under-counting for affected sessions.

## OpenCode SQLite Schema

Source: `~/.local/share/opencode/opencode.db` (Drizzle ORM)

### Actual Table Schemas

```sql
-- Sessions
CREATE TABLE session (
  id                TEXT PRIMARY KEY,
  project_id        TEXT,
  parent_id         TEXT,           -- references session(id) for subagents
  slug              TEXT,
  directory         TEXT,           -- project working directory
  title             TEXT,
  version           TEXT,
  share_url         TEXT,
  summary_additions INTEGER,
  summary_deletions INTEGER,
  summary_files     INTEGER,
  summary_diffs     TEXT,
  revert            TEXT,
  permission        TEXT,
  time_created      INTEGER,       -- unix ms
  time_updated      INTEGER,       -- unix ms
  time_compacting   INTEGER,
  time_archived     INTEGER,
  workspace_id      TEXT
);

-- Messages (role, modelID, tokens etc. are inside data JSON)
CREATE TABLE message (
  id              TEXT PRIMARY KEY,
  session_id      TEXT,
  time_created    INTEGER,         -- unix ms
  time_updated    INTEGER,         -- unix ms
  data            TEXT             -- JSON blob
);
-- message.data schema: { role, time, parentID, modelID, providerID, mode, agent, path, cost, tokens, variant, finish }

-- Parts (type is inside data JSON)
CREATE TABLE part (
  id              TEXT PRIMARY KEY,
  message_id      TEXT,
  session_id      TEXT,
  time_created    INTEGER,         -- unix ms
  time_updated    INTEGER,         -- unix ms
  data            TEXT             -- JSON blob
);
-- part.data schema varies by type:
--   text:      { type: "text", text, metadata, time }
--   tool:      { type: "tool", callID, tool, state }
--   reasoning: { type: "reasoning", text, metadata, time }
```

### Parser Requirements

- `role` and `modelID` must be extracted from `JSON_EXTRACT(message.data, '$.role')` etc.
- `part.type` must be extracted from `JSON_EXTRACT(part.data, '$.type')`
- Timestamps are unix milliseconds → divide by 1000 for seconds
- `session.directory` gives the project path
- `session.parent_id` links subagents (no `oc-` prefix needed since IDs are already namespaced: `ses_...`)
- Tool name: `JSON_EXTRACT(part.data, '$.tool')`
- Tool error: `JSON_EXTRACT(part.data, '$.state') = 'error'`

## Ingest Pipeline

### Claude Code Parser

Scans `~/.claude/projects/` using glob `*/*.jsonl`:

1. For each session JSONL (top-level, not in `subagents/`):
   - Parse line-by-line, filtering to `type: "user"` and `type: "assistant"` events
   - Skip events where `isMeta: true` (hook/system output)
   - Extract `sessionId` from first event that has it (skip `file-history-snapshot`)
   - Extract messages with `role`, `model`, `usage` tokens, `content`
   - Extract tool calls from assistant `message.content` blocks (type `tool_use`)
   - Detect tool errors from user `message.content` blocks (type `tool_result`, `is_error: true`)
   - Match errors to tool calls via `tool_use_id`
2. For each session, scan `<session-dir>/subagents/*.jsonl`:
   - Same message/tool parsing
   - Read companion `.meta.json` for `agentType` and `description`
   - Link via `parent_id` to parent session
   - Populate `subagent` table with `prompt` (first user message), `result` (last assistant message), `agent_type` (from `.meta.json`)
3. Check `ingest_log` before processing — skip files with matching mtime/hash
4. Wrap all inserts for a single session in a transaction

### OpenCode Parser

Reads `~/.local/share/opencode/opencode.db` via `bun:sqlite`:

1. Query `session` table for all sessions not yet in `ingest_log`
2. For each session:
   - Extract timestamps: `time_created` / `time_updated` (unix ms → Date)
   - Extract `directory` as project path, derive project name
   - Query `message` table, parse `data` JSON for `role`, `modelID`, `tokens`
   - Query `part` table, parse `data` JSON for `type`, tool name, error state
   - Walk `parent_id` chain for subagent relationships
3. Write normalized data to DuckDB in transactions

### Shared Persistence

Both parsers normalize to `NormalizedSession` and call a shared `persistSession()`
that handles all DuckDB inserts (session, messages, tool_calls, subagent, analysis record)
within a single transaction using prepared statements.

### Idempotency

The `ingest_log` table tracks what's been imported:
- **Claude Code**: keyed by file path + mtime. If mtime hasn't changed, skip.
- **OpenCode**: keyed by session ID from source DB. If already present, skip.

Re-ingest with `--force` to reprocess everything.

## Analysis Pipeline

### Triage (`analyze/triage.ts`)

Runs before any LLM call. For each session with `analysis.status = 'pending'`:

**Auto-skip if ALL of:**
- `message_count < 4`
- `turn_count < 2`
- `duration_s < 30`
- no tool calls

**Auto-analyze if ANY of:**
- has child sessions (subagents)
- `turn_count > 10`
- has error tool calls
- `duration_s > 300`

**Otherwise:** analyze with lower priority (processed after auto-analyze sessions).

Thresholds configurable in `config.toml` under `[analyze.triage]`.

### SDK Orchestration (`analyze/index.ts`)

Chunked `Promise.all` pattern:

```typescript
const chunks = chunkArray(sessions, config.analyze.parallelism);
for (const chunk of chunks) {
  const results = await Promise.all(
    chunk.map(session => analyzeSession(session))
  );
  for (const result of results) {
    await persistAnalysis(result);
  }
  if (config.analyze.delay_ms > 0) {
    await sleep(config.analyze.delay_ms);
  }
}
```

Each `analyzeSession()` call:
1. Assembles a condensed transcript (messages + tool names/errors, not full tool output)
2. Calls `query()` from `@anthropic-ai/claude-agent-sdk` with:
   - `systemPrompt: "You are a session analyst..."`
   - `settingSources: []` (hermetic, no CLAUDE.md contamination)
   - `persistSession: false`
   - `allowedTools: []`
   - `maxTurns: 1`
   - `effort: "low"`
   - `outputFormat: { type: "json_schema", schema: ANALYSIS_SCHEMA }`
3. Watches the async generator for activity (watchdog timeout)
4. Extracts `message.structured_output` from the result message

### Watchdog Timeout

Instead of a hard wall-clock timeout, we monitor activity on the SDK's async generator:

- If no new message arrives within `inactivity_timeout_ms` (default 30s), abort
- Long sessions producing steady output keep running
- Stuck calls get killed and marked `status = 'error'`, `error_reason = 'inactivity_timeout'`

### Failure Handling

| Outcome | Status | Retry? |
|---|---|---|
| Success | `complete` | No |
| SDK/network error | `error` | Yes, up to 3 times → then permanent `error` |
| Inactivity timeout | `error` | Yes, up to 3 times |
| Model refusal | `refused` | No — flagged for review |
| Parse error (bad JSON) | `error` | Yes, up to 3 times |
| Triage skip | `skipped` | No |

Consecutive failure circuit breaker: if `max_consecutive_failures` (default 5) errors occur in a row, the analyze run aborts entirely.

### Research Artifact Extraction

During analysis, subagent sessions are checked for research signals:

1. **Prompt keyword matching**: subagent `prompt` field checked against configurable patterns (`research`, `explore`, `evaluate`, `compare`, etc.) — supports regex
2. **Agent type matching**: subagent `agent_type` from `.meta.json` (e.g., `"research"`)
3. **LLM classification**: the analysis schema includes `is_research_subagent: boolean` and `research_topic: string | null`
4. If any signal fires, the subagent's `result` is extracted into `research_artifact` with LLM-generated `topic` and `tags`

## CLI Commands

```
recall ingest [--source claude-code|opencode|all] [--since DATE] [--force] [--verbose]
recall analyze [--limit N] [--force SESSION_ID] [--verbose]
recall sessions [--project NAME] [--since DATE] [--source TYPE] [--limit N]
recall show SESSION_ID
recall search QUERY [--in summaries|research|messages|all]
recall tools [--since DATE] [--project NAME] [--sort frequency|errors|duration]
recall frustrations [--since DATE] [--project NAME] [--include-refused]
recall research [--topic QUERY] [--tags TAG] [--list]
recall projects [--sort recent|sessions|tokens]
recall stats [--since DATE] [--by day|week|month]
recall export SESSION_ID [--format json|md]
```

All commands support `--json` and `--csv` output flags. Default is formatted tables.
All commands support `--verbose` and `--quiet` for log verbosity.

## Configuration

Lives at `~/.local/share/recall/config.toml`:

```toml
[database]
path = "~/.local/share/recall/recall.db"

[sources.claude-code]
enabled = true
path = "~/.claude/projects"

[sources.opencode]
enabled = true
path = "~/.local/share/opencode/opencode.db"

[analyze]
parallelism = 3
delay_ms = 2000
model = "claude-sonnet-4-6"
inactivity_timeout_ms = 30000
max_consecutive_failures = 5
max_retries = 3

[analyze.triage]
min_messages = 4
min_turns = 2
min_duration_s = 30
require_tool_calls = true
auto_analyze_if_subagents = true
auto_analyze_min_turns = 10
auto_analyze_if_errors = true
auto_analyze_min_duration_s = 300

[analyze.research]
prompt_signals = [
  "research", "explore", "evaluate", "compare",
  "find options", "look up", "search for",
  "alternatives", "investigate options",
  "what libraries", "how does .* work"
]

[output]
default_format = "table"
page_size = 20
```

## Database Location

```
~/.local/share/recall/
├── recall.db        # DuckDB database
└── config.toml      # configuration
```

Follows XDG Base Directory spec (`$XDG_DATA_HOME/recall/`).

## Distribution

Primary: `bun install -g` with `#!/usr/bin/env bun` shebang on `src/cli.ts`.
The `@duckdb/node-api` package includes platform-specific prebuilt binaries via
optional dependencies (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64).

`bun build --compile` is blocked by Bun issue #17312 (native `.node` addons cannot
be embedded). Revisit when resolved. DuckDB WASM dual-target is a potential
fallback if self-contained binary becomes a hard requirement.

## Future Considerations

- **MCP server mode**: expose queries as MCP tools for direct AI access without Bash
- **Additional sources**: Cursor, Codex, Gemini CLI — each gets a parser in `src/ingest/`
- **Scheduled ingest**: cron job or systemd timer for `recall ingest && recall analyze`
- **Web dashboard**: optional lightweight UI for browsing sessions and research
- **Embeddings**: vector search over session content for semantic queries
- **DuckDB FTS**: full-text search extension for `recall search` instead of ILIKE
- **Nix flake**: secondary distribution channel via `bun2nix`
