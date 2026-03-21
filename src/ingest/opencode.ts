import { Database as SQLiteDB } from "bun:sqlite";
import type { DuckDBConnection } from "@duckdb/node-api";
import { all, run } from "../db/index";
import type { IngestOptions, IngestResult } from "./index";
import { persistSession } from "./persist";
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
	const expandedPath = dbPath.replace("~", process.env.HOME ?? "");
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
					directory: string;
					title: string;
					time_created: number;
					time_updated: number;
				},
				[]
			>(
				"SELECT id, project_id, parent_id, directory, title, time_created, time_updated FROM session",
			)
			.all();

		for (const ocSession of sessions) {
			try {
				const sessionId = ocSession.id;

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
					await persistSession(db, session);
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
		directory: string;
		title: string;
		time_created: number;
		time_updated: number;
	},
	sessionId: string,
): NormalizedSession | null {
	// Get messages for this session — role/modelID/tokens are in the data JSON blob
	const rawMessages = sqlite
		.query<
			{ id: string; session_id: string; time_created: number; data: string },
			[string]
		>(
			"SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY rowid",
		)
		.all(ocSession.id);

	if (rawMessages.length === 0) return null;

	const messages: NormalizedMessage[] = [];
	const toolCalls: NormalizedToolCall[] = [];
	let turnCount = 0;
	let totalTokenInput = 0;
	let totalTokenOutput = 0;
	let lastRole = "";

	for (let seq = 0; seq < rawMessages.length; seq++) {
		const rawMsg = rawMessages[seq] as (typeof rawMessages)[number];

		let msgData: Record<string, unknown>;
		try {
			msgData = JSON.parse(rawMsg.data) as Record<string, unknown>;
		} catch {
			continue;
		}

		const role = (msgData.role as string) ?? "unknown";
		if (role === "user" && lastRole !== "user") turnCount++;
		lastRole = role;

		const tokens = msgData.tokens as Record<string, number> | undefined;
		const inputTokens = tokens?.input ?? 0;
		const outputTokens = tokens?.output ?? 0;
		totalTokenInput += inputTokens;
		totalTokenOutput += outputTokens;

		// Get parts for this message — type/tool info are in the data JSON blob
		const rawParts = sqlite
			.query<{ id: string; message_id: string; data: string }, [string]>(
				"SELECT id, message_id, data FROM part WHERE message_id = ? ORDER BY rowid",
			)
			.all(rawMsg.id);

		let textContent = "";
		let hasToolUse = false;

		for (const rawPart of rawParts) {
			let partData: Record<string, unknown>;
			try {
				partData = JSON.parse(rawPart.data) as Record<string, unknown>;
			} catch {
				continue;
			}

			if (partData.type === "text") {
				textContent += `${(partData.text as string) ?? ""}\n`;
			} else if (partData.type === "tool") {
				hasToolUse = true;
				const state = partData.state as
					| Record<string, unknown>
					| string
					| null
					| undefined;
				const isError =
					state === "error" ||
					(typeof state === "object" &&
						state !== null &&
						state.status === "error");
				const stateObj =
					typeof state === "object" && state !== null ? state : null;
				toolCalls.push({
					id: (partData.callID as string) ?? rawPart.id,
					messageId: rawMsg.id,
					sessionId,
					toolName: (partData.tool as string) ?? "unknown",
					inputSummary: stateObj?.input
						? JSON.stringify(stateObj.input).slice(0, 100)
						: null,
					isError,
					durationMs: null,
				});
			}
		}

		messages.push({
			id: rawMsg.id,
			sessionId,
			role,
			model: (msgData.modelID as string) ?? null,
			seq,
			timestamp: new Date(rawMsg.time_created),
			tokenInput: inputTokens,
			tokenOutput: outputTokens,
			content: textContent.trim() || null,
			hasToolUse,
		});
	}

	const parentId = ocSession.parent_id ?? null;

	let subagent: NormalizedSubagent | null = null;
	if (parentId) {
		const firstUserMsg = messages.find((m) => m.role === "user");
		const lastAssistantMsg = [...messages]
			.reverse()
			.find((m) => m.role === "assistant");
		subagent = {
			sessionId,
			agentType: null,
			description: null,
			slug: null,
			prompt: firstUserMsg?.content ?? null,
			result: lastAssistantMsg?.content ?? null,
		};
	}

	return {
		id: sessionId,
		source: "opencode",
		parentId,
		projectPath: ocSession.directory || null,
		projectName:
			ocSession.project_id === "global" ? null : ocSession.project_id,
		gitBranch: null,
		title: ocSession.title || null,
		startedAt: new Date(ocSession.time_created),
		endedAt: new Date(ocSession.time_updated),
		messageCount: messages.length,
		turnCount,
		tokenInput: totalTokenInput,
		tokenOutput: totalTokenOutput,
		durationS: Math.round(
			(ocSession.time_updated - ocSession.time_created) / 1000,
		),
		sourcePath: `opencode:${ocSession.id}`,
		messages,
		toolCalls,
		subagent,
	};
}
