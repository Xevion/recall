import type { DuckDBConnection } from "@duckdb/node-api";
import { Database as SQLiteDB } from "bun:sqlite";
import { all, run } from "../db/index";
import type { IngestOptions, IngestResult } from "./index";
import type {
	NormalizedMessage,
	NormalizedSession,
	NormalizedSubagent,
	NormalizedToolCall,
} from "./types";

export async function ingestOpenCode(
	db: DuckDBConnection,
	dbPath: string,
	opts: IngestOptions,
): Promise<IngestResult> {
	const expandedPath = dbPath.replace("~", process.env.HOME!);
	const result: IngestResult = {
		source: "opencode",
		sessionsIngested: 0,
		sessionsSkipped: 0,
		errors: [],
	};

	let sqlite: SQLiteDB;
	try {
		sqlite = new SQLiteDB(expandedPath, { readonly: true });
	} catch (err) {
		result.errors.push(`Failed to open OpenCode DB: ${err}`);
		return result;
	}

	try {
		const sessions = sqlite
			.query<
				{
					id: string;
					project_id: string;
					parent_id: string | null;
					title: string | null;
				},
				[]
			>("SELECT id, project_id, parent_id, title FROM session")
			.all();

		for (const ocSession of sessions) {
			try {
				const sessionId = `oc-${ocSession.id}`;

				// Check if already ingested
				if (!opts.force) {
					const existing = await all(
						db,
						"SELECT source_path FROM ingest_log WHERE session_id = ?",
						sessionId,
					);
					if (existing.length > 0) {
						result.sessionsSkipped++;
						continue;
					}
				}

				const session = parseOpenCodeSession(sqlite, ocSession, sessionId);
				if (session) {
					await persistOpenCodeSession(db, session);
					await run(
						db,
						"INSERT OR REPLACE INTO ingest_log (source_path, source, session_id) VALUES (?, 'opencode', ?)",
						`opencode:${ocSession.id}`,
						sessionId,
					);
					result.sessionsIngested++;
				}
			} catch (err) {
				result.errors.push(`session ${ocSession.id}: ${err}`);
			}
		}
	} finally {
		sqlite.close();
	}

	return result;
}

function parseOpenCodeSession(
	sqlite: SQLiteDB,
	ocSession: {
		id: string;
		project_id: string;
		parent_id: string | null;
		title: string | null;
	},
	sessionId: string,
): NormalizedSession | null {
	// Get messages for this session
	const ocMessages = sqlite
		.query<
			{ id: string; session_id: string; role: string; model_id: string | null },
			[string]
		>(
			"SELECT id, session_id, role, model_id FROM message WHERE session_id = ? ORDER BY rowid",
			ocSession.id,
		)
		.all();

	if (ocMessages.length === 0) return null;

	// Get parts for all messages
	const messages: NormalizedMessage[] = [];
	const toolCalls: NormalizedToolCall[] = [];
	let turnCount = 0;
	let lastRole = "";

	for (let seq = 0; seq < ocMessages.length; seq++) {
		const ocMsg = ocMessages[seq];
		const role = ocMsg.role;

		if (role === "user" && lastRole !== "user") turnCount++;
		lastRole = role;

		const parts = sqlite
			.query<{ id: string; type: string; data: string }, [string]>(
				"SELECT id, type, data FROM part WHERE message_id = ? ORDER BY rowid",
				ocMsg.id,
			)
			.all();

		let textContent = "";
		let hasToolUse = false;

		for (const part of parts) {
			try {
				const data = JSON.parse(part.data);
				if (part.type === "text") {
					textContent += (data.text ?? data.value ?? "") + "\n";
				} else if (part.type === "tool") {
					hasToolUse = true;
					toolCalls.push({
						id: part.id,
						messageId: ocMsg.id,
						sessionId,
						toolName: data.tool ?? data.name ?? "unknown",
						inputSummary: data.args
							? JSON.stringify(data.args).slice(0, 100)
							: null,
						isError: data.status === "error",
						durationMs: null,
					});
				}
			} catch {
				// Skip unparseable parts
			}
		}

		messages.push({
			id: ocMsg.id,
			sessionId,
			role,
			model: ocMsg.model_id,
			seq,
			timestamp: null, // OpenCode doesn't store per-message timestamps in the same way
			tokenInput: 0,
			tokenOutput: 0,
			content: textContent.trim() || null,
			hasToolUse,
		});
	}

	const parentId = ocSession.parent_id ? `oc-${ocSession.parent_id}` : null;

	let subagent: NormalizedSubagent | null = null;
	if (parentId) {
		const firstUserMsg = messages.find((m) => m.role === "user");
		const lastAssistantMsg = [...messages]
			.reverse()
			.find((m) => m.role === "assistant");
		subagent = {
			sessionId,
			agentType: null,
			slug: null,
			prompt: firstUserMsg?.content ?? null,
			result: lastAssistantMsg?.content ?? null,
		};
	}

	return {
		id: sessionId,
		source: "opencode",
		parentId,
		projectPath: null,
		projectName:
			ocSession.project_id === "global" ? null : ocSession.project_id,
		gitBranch: null,
		title: ocSession.title,
		startedAt: new Date(), // Will be refined when we have timestamp data
		endedAt: null,
		messageCount: messages.length,
		turnCount,
		tokenInput: 0,
		tokenOutput: 0,
		durationS: 0,
		sourcePath: `opencode:${ocSession.id}`,
		messages,
		toolCalls,
		subagent,
	};
}

async function persistOpenCodeSession(
	db: DuckDBConnection,
	session: NormalizedSession,
): Promise<void> {
	// Reuse the same persistence logic as claude-code
	// TODO: extract shared persistSession into a common module
	await run(
		db,
		`INSERT OR REPLACE INTO session
     (id, source, parent_id, project_path, project_name, git_branch, title,
      started_at, ended_at, message_count, turn_count, token_input, token_output,
      duration_s, source_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		session.id,
		session.source,
		session.parentId,
		session.projectPath,
		session.projectName,
		session.gitBranch,
		session.title,
		session.startedAt.toISOString(),
		session.endedAt?.toISOString() ?? null,
		session.messageCount,
		session.turnCount,
		session.tokenInput,
		session.tokenOutput,
		session.durationS,
		session.sourcePath,
	);

	for (const msg of session.messages) {
		await run(
			db,
			`INSERT OR REPLACE INTO message
       (id, session_id, role, model, seq, timestamp, token_input, token_output, content, has_tool_use)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			msg.id,
			msg.sessionId,
			msg.role,
			msg.model,
			msg.seq,
			msg.timestamp?.toISOString() ?? null,
			msg.tokenInput,
			msg.tokenOutput,
			msg.content,
			msg.hasToolUse,
		);
	}

	for (const tc of session.toolCalls) {
		await run(
			db,
			`INSERT OR REPLACE INTO tool_call
       (id, message_id, session_id, tool_name, input_summary, is_error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
			tc.id,
			tc.messageId,
			tc.sessionId,
			tc.toolName,
			tc.inputSummary,
			tc.isError,
			tc.durationMs,
		);
	}

	if (session.subagent) {
		await run(
			db,
			`INSERT OR REPLACE INTO subagent
       (session_id, agent_type, slug, prompt, result)
       VALUES (?, ?, ?, ?, ?)`,
			session.subagent.sessionId,
			session.subagent.agentType,
			session.subagent.slug,
			session.subagent.prompt,
			session.subagent.result,
		);
	}

	await run(
		db,
		`INSERT OR IGNORE INTO analysis (session_id, status) VALUES (?, 'pending')`,
		session.id,
	);
}
