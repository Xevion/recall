import type { DuckDBConnection } from "@duckdb/node-api";
import { resolve } from "node:path";
import { all, run } from "../db/index";
import type { IngestOptions, IngestResult } from "./index";
import type {
	NormalizedMessage,
	NormalizedSession,
	NormalizedSubagent,
	NormalizedToolCall,
} from "./types";

export async function ingestClaudeCode(
	db: DuckDBConnection,
	basePath: string,
	opts: IngestOptions,
): Promise<IngestResult> {
	const expandedPath = basePath.replace("~", process.env.HOME!);
	const result: IngestResult = {
		source: "claude-code",
		sessionsIngested: 0,
		sessionsSkipped: 0,
		errors: [],
	};

	// Find all session JSONL files (top-level, not in subagents/)
	const glob = new Bun.Glob("*/*.jsonl");
	const sessionFiles: string[] = [];

	for await (const path of glob.scan({ cwd: expandedPath, absolute: true })) {
		// Skip files inside subagents/ directories
		if (path.includes("/subagents/")) continue;
		sessionFiles.push(path);
	}

	for (const filePath of sessionFiles) {
		try {
			// Check ingest_log for idempotency
			if (!opts.force) {
				const stat = await Bun.file(filePath).stat();
				const existing = await all(
					db,
					"SELECT source_path FROM ingest_log WHERE source_path = ? AND file_mtime = ?",
					filePath,
					stat?.mtime?.toISOString(),
				);
				if (existing.length > 0) {
					result.sessionsSkipped++;
					continue;
				}
			}

			const session = await parseClaudeCodeSession(filePath);
			if (session) {
				await persistSession(db, session);
				// Also ingest subagent sessions
				const subagentDir = filePath.replace(".jsonl", "") + "/subagents";
				const subGlob = new Bun.Glob("*.jsonl");
				try {
					for await (const subPath of subGlob.scan({
						cwd: subagentDir,
						absolute: true,
					})) {
						const subSession = await parseClaudeCodeSession(
							subPath,
							session.id,
						);
						if (subSession) {
							await persistSession(db, subSession);
						}
					}
				} catch {
					// No subagents directory — that's fine
				}

				const stat = await Bun.file(filePath).stat();
				await run(
					db,
					"INSERT OR REPLACE INTO ingest_log (source_path, source, file_mtime, session_id) VALUES (?, 'claude-code', ?, ?)",
					filePath,
					stat?.mtime?.toISOString(),
					session.id,
				);
				result.sessionsIngested++;
			}
		} catch (err) {
			result.errors.push(`${filePath}: ${err}`);
		}
	}

	return result;
}

async function parseClaudeCodeSession(
	filePath: string,
	parentId?: string,
): Promise<NormalizedSession | null> {
	const text = await Bun.file(filePath).text();
	const lines = text.trim().split("\n").filter(Boolean);
	if (lines.length === 0) return null;

	const events: Record<string, unknown>[] = [];
	for (const line of lines) {
		try {
			events.push(JSON.parse(line));
		} catch {
			// Skip malformed lines
		}
	}
	if (events.length === 0) return null;

	const firstEvent = events[0] as Record<string, unknown>;
	const lastEvent = events[events.length - 1] as Record<string, unknown>;
	const sessionId = (firstEvent.sessionId as string) ?? filePath;

	const messages: NormalizedMessage[] = [];
	const toolCalls: NormalizedToolCall[] = [];
	let turnCount = 0;
	let totalTokenInput = 0;
	let totalTokenOutput = 0;
	let lastRole = "";
	let seq = 0;

	for (const event of events) {
		const type = event.type as string;
		if (type !== "user" && type !== "assistant") continue;

		const msg = event.message as Record<string, unknown> | undefined;
		if (!msg) continue;

		const role = msg.role as string;
		if (role === "user" && lastRole !== "user") turnCount++;
		lastRole = role;

		const usage = msg.usage as Record<string, number> | undefined;
		const inputTokens = usage?.input_tokens ?? 0;
		const outputTokens = usage?.output_tokens ?? 0;
		totalTokenInput += inputTokens;
		totalTokenOutput += outputTokens;

		const contentBlocks = msg.content as
			| Array<Record<string, unknown>>
			| string
			| undefined;
		let textContent = "";
		let hasToolUse = false;

		if (Array.isArray(contentBlocks)) {
			for (const block of contentBlocks) {
				if (block.type === "text") {
					textContent += (block.text as string) + "\n";
				} else if (block.type === "tool_use") {
					hasToolUse = true;
					toolCalls.push({
						id: (block.id as string) ?? `tc-${seq}-${toolCalls.length}`,
						messageId: (msg.id as string) ?? `msg-${seq}`,
						sessionId,
						toolName: block.name as string,
						inputSummary: summarizeInput(
							block.input as Record<string, unknown>,
						),
						isError: false,
						durationMs: null,
					});
				}
			}
		} else if (typeof contentBlocks === "string") {
			textContent = contentBlocks;
		}

		messages.push({
			id: (msg.id as string) ?? `msg-${seq}`,
			sessionId,
			role,
			model: (msg.model as string) ?? null,
			seq: seq++,
			timestamp: event.timestamp ? new Date(event.timestamp as string) : null,
			tokenInput: inputTokens,
			tokenOutput: outputTokens,
			content: textContent.trim() || null,
			hasToolUse,
		});
	}

	// Check for tool_result events to mark errors
	for (const event of events) {
		if (event.type === "tool_result") {
			const toolResult = event as Record<string, unknown>;
			if (toolResult.is_error) {
				const tc = toolCalls.find((t) => t.id === toolResult.tool_use_id);
				if (tc) tc.isError = true;
			}
		}
	}

	// Extract subagent metadata
	let subagent: NormalizedSubagent | null = null;
	if (parentId || (firstEvent.isSidechain as boolean)) {
		const firstUserMsg = messages.find((m) => m.role === "user");
		const lastAssistantMsg = [...messages]
			.reverse()
			.find((m) => m.role === "assistant");
		subagent = {
			sessionId,
			agentType: (firstEvent.agentType as string) ?? null,
			slug: (firstEvent.slug as string) ?? null,
			prompt: firstUserMsg?.content ?? null,
			result: lastAssistantMsg?.content ?? null,
		};
	}

	const startedAt = new Date((firstEvent.timestamp as string) ?? Date.now());
	const endedAt = new Date((lastEvent.timestamp as string) ?? Date.now());
	const durationS = Math.round(
		(endedAt.getTime() - startedAt.getTime()) / 1000,
	);

	// Derive project name from path
	const pathParts = filePath.split("/");
	const projectIdx = pathParts.indexOf("projects");
	const projectDir = projectIdx >= 0 ? pathParts[projectIdx + 1] : null;
	const projectName = projectDir
		? projectDir.replace(/^-/, "").replace(/-/g, "/")
		: null;

	return {
		id: sessionId,
		source: "claude-code",
		parentId: parentId ?? null,
		projectPath: (firstEvent.cwd as string) ?? null,
		projectName,
		gitBranch: (firstEvent.gitBranch as string) ?? null,
		title: null,
		startedAt,
		endedAt,
		messageCount: messages.length,
		turnCount,
		tokenInput: totalTokenInput,
		tokenOutput: totalTokenOutput,
		durationS,
		sourcePath: filePath,
		messages,
		toolCalls,
		subagent,
	};
}

function summarizeInput(
	input: Record<string, unknown> | undefined,
): string | null {
	if (!input) return null;
	// For common tools, extract the key field
	if (input.file_path) return `file: ${input.file_path}`;
	if (input.command) return `cmd: ${String(input.command).slice(0, 100)}`;
	if (input.pattern) return `pattern: ${input.pattern}`;
	if (input.query) return `query: ${String(input.query).slice(0, 100)}`;
	if (input.prompt) return `prompt: ${String(input.prompt).slice(0, 100)}`;
	return JSON.stringify(input).slice(0, 100);
}

async function persistSession(
	db: DuckDBConnection,
	session: NormalizedSession,
): Promise<void> {
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

	// Create pending analysis record
	await run(
		db,
		`INSERT OR IGNORE INTO analysis (session_id, status) VALUES (?, 'pending')`,
		session.id,
	);
}
