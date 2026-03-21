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

	// Extract sessionId from first event that has it (file-history-snapshot has none)
	const metaEvent = events.find((e) => e.sessionId != null) ?? events[0] ?? {};
	const sessionId = (metaEvent.sessionId as string) ?? filePath;

	const firstTimestampedEvent =
		events.find((e) => e.timestamp != null) ?? events[0] ?? {};
	const lastTimestampedEvent =
		[...events].reverse().find((e) => e.timestamp != null) ??
		events[events.length - 1] ??
		{};

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

		// Skip meta events (system prompts, tool injection, etc.)
		if (event.isMeta === true) continue;

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
				} else if (block.type === "tool_result" && block.is_error) {
					// Mark the corresponding tool call as errored
					const tc = toolCalls.find((t) => t.id === block.tool_use_id);
					if (tc) tc.isError = true;
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

	// Skip sessions with no real messages (e.g. only file-history-snapshot events)
	if (messages.length === 0) return null;

	// Read .meta.json companion file for subagent agentType and description
	let subagent: NormalizedSubagent | null = null;
	if (parentId || (metaEvent.isSidechain as boolean)) {
		const firstUserMsg = messages.find((m) => m.role === "user");
		const lastAssistantMsg = [...messages]
			.reverse()
			.find((m) => m.role === "assistant");

		let agentType: string | null = (metaEvent.agentType as string) ?? null;
		let description: string | null = null;

		const metaPath = filePath.replace(".jsonl", ".meta.json");
		const metaFile = Bun.file(metaPath);
		if (await metaFile.exists()) {
			try {
				const meta = JSON.parse(await metaFile.text()) as Record<
					string,
					unknown
				>;
				agentType = (meta.agentType as string) ?? agentType;
				description = (meta.description as string) ?? null;
			} catch {
				// Ignore malformed .meta.json
			}
		}

		subagent = {
			sessionId,
			agentType,
			description,
			slug: (metaEvent.slug as string) ?? null,
			prompt: firstUserMsg?.content ?? null,
			result: lastAssistantMsg?.content ?? null,
		};
	}

	const startedAt = new Date(
		(firstTimestampedEvent.timestamp as string) ?? Date.now(),
	);
	const endedAt = new Date(
		(lastTimestampedEvent.timestamp as string) ?? Date.now(),
	);
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
		projectPath: (metaEvent.cwd as string) ?? null,
		projectName,
		gitBranch: (metaEvent.gitBranch as string) ?? null,
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
