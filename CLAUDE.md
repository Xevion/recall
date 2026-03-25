# Recall

Session history database for AI coding assistants (Claude Code, OpenCode).

## Architecture

Two-phase pipeline:
1. **Ingest** — parse source JSONL/SQLite into DuckDB
2. **Analyze** — selective AI analysis via `@anthropic-ai/claude-agent-sdk`

## Tech Stack

- **Runtime**: Bun
- **Database**: DuckDB at `~/.local/share/recall/recall.db`
- **Config**: TOML at `~/.local/share/recall/config.toml`
- **AI**: `@anthropic-ai/claude-agent-sdk` with JSON schema output
- **CLI**: Commander
- **Logging**: LogTape (`@logtape/logtape`) — colored stderr sink + optional JSONL file sink
- **Tooling**: mise (`mise.toml` manages duckdb binary)

## Database Queries (Ad-hoc)

For ad-hoc DB queries outside of application code, use the duckdb CLI binary managed by mise:

```bash
mise exec -- duckdb ~/.local/share/recall/recall.db "SELECT ..."
```

Do NOT write temp bun/ts scripts to query the database. The duckdb binary is faster and avoids Node API compatibility issues.

## Long-Running Processes

`recall ingest` and `recall analyze` can be long-running and hold a DuckDB connection. **NEVER kill these processes.** DuckDB is single-writer — killing mid-write risks corruption. If a process is holding the database lock:

1. Check if ingest/analyze is running (`ps aux | grep recall`)
2. If yes, wait for it to finish or ask the user to confirm it's safe to proceed
3. Do NOT use `kill`, `pkill`, or similar to force-terminate recall processes

## Graceful Shutdown

Both `ingest` and `analyze` support graceful shutdown via AbortSignal:

- **First Ctrl+C**: Signals abort — current unit of work finishes, then exits cleanly
- **Second Ctrl+C**: Force quit with `process.exit(1)`
- **Timeout**: Auto force-quit after 5s (ingest), 30s (analyze), 3s (read commands)

The shutdown controller (`src/utils/shutdown.ts`) is a singleton accessed via `getShutdownController()`. Signal handlers are installed per-command in `cli.ts`'s `preAction` hook with context-dependent timeouts.

## Logging Levels

Log level policy for structured logging:

- **info**: User-visible progress (session counts, milestones, completion counters)
- **debug**: Implementation detail (per-file processing, triage decisions, prompt sizes)
- **warn**: Recoverable errors (circuit breaker, retries exhausted, model refusals)
- **error**: Fatal errors (rate limit rejection, unrecoverable failures)
- **trace**: Verbose debugging (prompt previews, SDK message types)

Verbosity mapping: default=info, `-v`=debug, `-vv`=trace, `-q`=error only

## Commands

```
bun run src/cli.ts <command>     # development
recall <command>                  # after bun link
```

Global flags: `-v`/`-vv`/`-vvv` (verbosity), `-q` (quiet), `--log-file <path>` (JSONL log output).

### Available Subcommands

- `ingest` — parse and store sessions from Claude Code JSONL / OpenCode SQLite
- `analyze` — run LLM analysis on pending sessions
- `export` — export session data
- `fts` — manage full-text search indexes (rebuild, check)
- `sessions` — list/filter sessions with rich table output
- `show` — show detail for a single session
- `search` — full-text search across messages, analysis, research
- `tools` — tool call statistics
- `frustrations` — list frustration events from analysis
- `research` — list research artifacts
- `projects` — list projects with session counts
- `stats` — aggregate usage statistics

## Key Files

- `src/cli.ts` — entry point, command routing, global flags
- `src/config.ts` — TOML config loading
- `src/db/schema.ts` — DuckDB table definitions and enum init
- `src/db/index.ts` — DuckDB connection helpers (`run`, `all`, `withDb`)
- `src/db/queries.ts` — reusable query functions
- `src/db/fts.ts` — FTS index build/check helpers
- `src/ingest/index.ts` — ingest orchestration and shared types
- `src/ingest/types.ts` — normalized type definitions (`NormalizedSession`, etc.)
- `src/ingest/persist.ts` — shared `persistSession` used by both parsers
- `src/ingest/claude-code.ts` — Claude Code JSONL parser
- `src/ingest/opencode.ts` — OpenCode SQLite reader
- `src/analyze/index.ts` — SDK orchestration (pool-based concurrency via `runPool`)
- `src/analyze/triage.ts` — skip/analyze decision logic
- `src/analyze/prompt.ts` — LLM prompt construction
- `src/analyze/research.ts` — research artifact extraction
- `src/analyze/schema.ts` — `AnalysisOutput` type and JSON schema export
- `src/analyze/topics.ts` — seeded topic vocabulary (`category:tag` format)
- `src/logging/setup.ts` — LogTape configure/teardown
- `src/logging/sink.ts` — custom colored stderr sink
- `src/commands/` — one file per CLI subcommand
- `src/utils/theme.ts` — shared ansis color theme
- `src/utils/colors.ts` — color helpers
- `src/utils/table.ts` — cli-table3 helpers
- `src/utils/format.ts` — formatting utilities (dates, durations, word wrap)
- `src/utils/path.ts` — path helpers
- `src/utils/validation.ts` — `ValidationError` and input validation
- `src/utils/shutdown.ts` — shutdown controller singleton and signal handler setup
- `src/utils/pool.ts` — signal-aware concurrency pool for analyze pipeline
- `schemas/analysis-output.json` — JSON schema for LLM analysis output
- `docs/design.md` — full design document

## Analysis Schema

`AnalysisOutput` fields (from `src/analyze/schema.ts`):

| Field | Type | Notes |
|---|---|---|
| `title` | `string` | short session title |
| `summary` | `string` | prose summary |
| `outcome` | `completed \| progressed \| abandoned \| pivoted` | overall session outcome |
| `outcome_confidence` | `high \| medium \| low` | confidence in outcome |
| `session_types` | `SessionType[]` | `implementation`, `exploration`, `debugging`, `planning`, `review`, `maintenance`, `research` |
| `topics` | `string[]` | `category:tag` format, from vocabulary in `topics.ts` |
| `frustrations` | `Frustration[]` | `{ category, description, severity }` — categories: `tool_failure`, `user_correction`, `external_blocker`, `workflow_antipattern` |
| `actionable_insight` | `string \| null` | single improvement suggestion |
| `is_research_subagent` | `boolean` | whether this is a research subagent |
| `research_topic` / `research_tags` | `string \| null` | populated when `is_research_subagent` is true |

## Conventions

- Analysis statuses: `pending`, `processing`, `complete`, `skipped`, `error`, `refused`, `retry_pending`
- Topics use two-tier `category:tag` format; vocabulary seeded in `src/analyze/topics.ts`
- OpenCode session IDs are prefixed with `oc-` to avoid collisions
- Subagents are sessions with `parent_id` set; metadata in `subagent` table
- Research artifacts auto-extracted from subagents matching prompt signal patterns
- Ingest is idempotent via `ingest_log` (keyed on `source_path` + `file_mtime` for claude-code, `session_id` for opencode)
- Subagent metadata read from `.meta.json` companion files alongside JSONL (claude-code only)
- FTS indexes cover `message(content)`, `analysis(title, summary, actionable_insight)`, `research_artifact(topic, content)` — rebuilt via `fts` command or on demand
- AbortSignal is threaded through write pipelines (ingest, analyze) for graceful shutdown; read commands rely on the force timeout
- `runPool()` in `src/utils/pool.ts` replaces chunk-based `Promise.all` for analyze concurrency — supports abort signal and circuit breaker via `onTaskComplete` callback

## Full-Text Search

DuckDB FTS extension is loaded at schema init. Three indexes are managed in `src/db/fts.ts`. Rebuild with:

```bash
recall fts rebuild
```

## Linear Issue Tracking

Recall tracks work in [Linear](https://linear.app/xevion-personal/project/recall-92d9d103e6a8) under the **Recall** project.

- **Team:** `Xevion's Personal`
- **Project:** `Recall` — filter by this when querying issues
- **Issue prefix:** `XEV-` (team-level — all projects under this team share it)

### Labels

**Domain:** Ingest, Analysis, CLI
**Type:** Bug, Feature, Improvement, Refactoring, Documentation, Testing

### Working with Issues

Use the `linear-issue` skill for creating issues, or reference issues directly (e.g., "work on XEV-###").

**Always move issues to "In Progress" before writing code. Do NOT mark "Done" until confirmed.**
