---
name: recall
description: "Query AI session history from the recall database. Auto-activates on first message to check recent project context. Also invokable with /recall for deeper queries like searching past sessions, frustrations, research artifacts, and tool usage patterns."
---

# Recall — AI Session History

Query past AI coding sessions stored in the recall database. This skill has two modes:

## Auto-Activation (Session Start)

On the first message of a session, silently check for recent project context:

1. Run: `recall context --project --since 14d -q`
   - This auto-detects the project from cwd and returns JSON
   - Use `-q` to suppress log noise
   - If the command fails (e.g., DB locked by running analysis), silently move on
2. **If the command succeeds and returns sessions**: Internalize the context silently. Do NOT dump the JSON to the user. Use it to inform your work — you now know what was recently worked on, what topics are active, and what frustrations occurred.
3. **If the command fails or returns 0 sessions**: Move on silently. The database may be locked by a running ingest/analyze process — this is normal. Do not mention recall, suggest running analysis, or attempt to diagnose the lock unless the user asks about past work.
4. **If `unanalyzed_count` is high relative to `session_count`**: Note this internally. If the user later asks about past work and you can't find relevant sessions, suggest: `recall analyze --project <name> --since <period>`

**Important**: The auto-activation should be invisible to the user. Never say "I checked your recall database" or "Let me look up your session history" unprompted. Just use the context naturally.

## User-Invoked Mode (`/recall`)

When the user invokes `/recall` or asks about past sessions/work history, use the full recall CLI to answer their question.

### Command Selection

Match the user's intent to the right command:

| User intent | Command |
|-------------|---------|
| "What have I been working on?" | `recall context --project --pretty` |
| "Show me recent sessions" | `recall sessions --project --since 7d --json` |
| "Have I seen this error before?" | `recall search "<error text>" --in messages --json` |
| "What research do I have on X?" | `recall research --topic "<query>" --json` |
| "Show me frustrations/pain points" | `recall frustrations --project --since 14d --json` |
| "What tools do I use most?" | `recall tools --project --json` |
| "Show me project stats" | `recall stats` |
| "List all projects" | `recall projects` |
| "Show details of a session" | `recall show <session-id>` |

### Common Flags

- `--project` (bare) — auto-detect project from cwd. Use this by default.
- `--project <name>` — explicit project filter
- `--since <date>` — relative dates: `3d`, `1w`, `2w`, `30d`, `yesterday`
- `--json` — machine-readable output (use for programmatic parsing)
- `--pretty` — pretty-print JSON (use with `context` for readable output)
- `-l, --limit <n>` — cap result count
- `-q` — quiet mode (suppress log output)

### Search Scopes

`recall search` has multiple scopes via `--in`:
- `summaries` (default) — search analysis titles and summaries
- `messages` — search raw message content (slower, more comprehensive)
- `research` — search research artifacts
- `all` — search everything

### Workflow

1. **Pick the command** that matches the user's question
2. **Always use `--project`** (bare) unless the user asks about a different project or all projects
3. **Use `--json`** when you need to parse the output programmatically
4. **Present results as a concise summary**, not raw JSON dumps. Extract the relevant parts and present them naturally.
5. **If no results**: Check if sessions exist but aren't analyzed (`recall sessions --project --status pending --limit 1`). If so, suggest running analysis: `recall analyze --project --since <period>`

### Analysis On-Demand

If the user needs analyzed data but sessions are pending:

```bash
# Check what's pending
recall analyze --project --since 7d --dry-run

# Run analysis (this calls the LLM — may take a while)
recall analyze --project --since 7d
```

**Do NOT run `recall analyze` without the user's knowledge** — it makes LLM API calls that cost money. Always confirm before running analysis.

### Tips

- `recall context` is the best starting point for "where did I leave off?" questions — it aggregates sessions, topics, and frustrations into a single view
- Frustrations are particularly useful for avoiding past mistakes in the current session
- Research artifacts contain knowledge gathered by subagents — valuable for "have I researched this before?" questions
- Topic frequency from `recall context` shows what domains are active — use this to calibrate your approach
