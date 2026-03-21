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

## Commands

```
bun run src/cli.ts <command>     # development
recall <command>                  # after bun build --compile
```

## Key Files

- `src/cli.ts` — entry point, command routing
- `src/db/schema.ts` — DuckDB table definitions
- `src/ingest/claude-code.ts` — Claude Code JSONL parser
- `src/ingest/opencode.ts` — OpenCode SQLite reader
- `src/analyze/index.ts` — SDK orchestration (chunked Promise.all)
- `src/analyze/triage.ts` — skip/analyze decision logic
- `schemas/analysis-output.json` — JSON schema for LLM analysis output
- `docs/design.md` — full design document

## Conventions

- Analysis statuses: pending, processing, complete, skipped, error, refused, retry_pending
- OpenCode session IDs are prefixed with `oc-` to avoid collisions
- Subagents are sessions with `parent_id` set; metadata in `subagent` table
- Research artifacts auto-extracted from subagents matching prompt signal patterns
