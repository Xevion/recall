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
- **Tooling**: mise (`mise.toml` manages duckdb binary)

## Database Queries (Ad-hoc)

For ad-hoc DB queries outside of application code, use the duckdb CLI binary managed by mise:

```bash
mise exec -- duckdb ~/.local/share/recall/recall.db "SELECT ..."
```

Do NOT write temp bun/ts scripts to query the database. The duckdb binary is faster and avoids Node API compatibility issues.

## Commands

```
bun run src/cli.ts <command>     # development
recall <command>                  # after bun build --compile
```

## Key Files

- `src/cli.ts` — entry point, command routing
- `src/config.ts` — TOML config loading
- `src/db/schema.ts` — DuckDB table definitions
- `src/db/index.ts` — DuckDB connection helpers (`run`, `all`)
- `src/db/queries.ts` — reusable query functions
- `src/ingest/index.ts` — ingest orchestration and shared types
- `src/ingest/types.ts` — normalized type definitions (NormalizedSession, etc.)
- `src/ingest/persist.ts` — shared `persistSession` used by both parsers
- `src/ingest/claude-code.ts` — Claude Code JSONL parser
- `src/ingest/opencode.ts` — OpenCode SQLite reader
- `src/analyze/index.ts` — SDK orchestration (chunked Promise.all)
- `src/analyze/triage.ts` — skip/analyze decision logic
- `src/analyze/prompt.ts` — LLM prompt construction
- `src/analyze/research.ts` — research artifact extraction
- `src/analyze/schema.ts` — JSON schema helpers for LLM output
- `src/commands/` — one file per CLI subcommand
- `src/utils/` — path, logger, validation helpers
- `schemas/analysis-output.json` — JSON schema for LLM analysis output
- `docs/design.md` — full design document

## Conventions

- Analysis statuses: pending, processing, complete, skipped, error, refused, retry_pending
- OpenCode session IDs are prefixed with `oc-` to avoid collisions
- Subagents are sessions with `parent_id` set; metadata in `subagent` table
- Research artifacts auto-extracted from subagents matching prompt signal patterns
- Ingest is idempotent via `ingest_log` (keyed on `source_path` + `file_mtime` for claude-code, `session_id` for opencode)
- Subagent metadata read from `.meta.json` companion files alongside JSONL (claude-code only)

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
