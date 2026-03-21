import { query } from "@anthropic-ai/claude-agent-sdk";
import type { DuckDBConnection } from "@duckdb/node-api";
import { loadConfig } from "../config";
import { all, run } from "../db/index";
import { debug, trace } from "../utils/logger";
import { buildAnalysisPrompt } from "./prompt";
import { type AnalysisOutput, analysisSchema } from "./schema";
import { type TriageInput, triageSession } from "./triage";

export interface AnalyzeOptions {
	limit?: number;
	force?: string; // force re-analyze a specific session ID
}

export interface AnalyzeResult {
	analyzed: number;
	skipped: number;
	errors: number;
	refused: number;
}

export async function analyze(
	db: DuckDBConnection,
	opts: AnalyzeOptions,
): Promise<AnalyzeResult> {
	const config = await loadConfig();
	const result: AnalyzeResult = {
		analyzed: 0,
		skipped: 0,
		errors: 0,
		refused: 0,
	};

	// Get sessions pending analysis
	let sessions: Array<{
		id: string;
		message_count: number;
		turn_count: number;
		duration_s: number;
		parent_id: string | null;
	}>;

	debug(`analyze: limit=${opts.limit ?? 100}, force=${opts.force ?? "none"}`);

	if (opts.force) {
		sessions = await all(
			db,
			"SELECT id, message_count, turn_count, duration_s, parent_id FROM session WHERE id = ?",
			opts.force,
		);
		// Reset analysis status
		await run(
			db,
			"UPDATE analysis SET status = 'pending', retry_count = 0 WHERE session_id = ?",
			opts.force,
		);
	} else {
		sessions = await all(
			db,
			`SELECT s.id, s.message_count, s.turn_count, s.duration_s, s.parent_id
       FROM session s
       JOIN analysis a ON s.id = a.session_id
       WHERE a.status IN ('pending', 'retry_pending')
       ORDER BY s.started_at DESC
       LIMIT ?`,
			opts.limit ?? 100,
		);
	}

	debug(`analyze: ${sessions.length} candidate session(s) found`);

	const toAnalyze: typeof sessions = [];
	for (const session of sessions) {
		const hasToolCalls =
			(
				await all(
					db,
					"SELECT 1 FROM tool_call WHERE session_id = ? LIMIT 1",
					session.id,
				)
			).length > 0;
		const hasSubagents =
			(
				await all(
					db,
					"SELECT 1 FROM session WHERE parent_id = ? LIMIT 1",
					session.id,
				)
			).length > 0;
		const hasErrors =
			(
				await all(
					db,
					"SELECT 1 FROM tool_call WHERE session_id = ? AND is_error = TRUE LIMIT 1",
					session.id,
				)
			).length > 0;

		const input: TriageInput = {
			sessionId: session.id,
			messageCount: session.message_count ?? 0,
			turnCount: session.turn_count ?? 0,
			durationS: session.duration_s ?? 0,
			hasToolCalls,
			hasSubagents,
			hasErrors,
		};

		const decision = triageSession(input, config.analyze.triage);
		if (decision === "skip") {
			debug(
				`triage: skip ${session.id} (msgs=${input.messageCount}, turns=${input.turnCount}, dur=${input.durationS}s)`,
			);
			await run(
				db,
				"UPDATE analysis SET status = 'skipped' WHERE session_id = ?",
				session.id,
			);
			result.skipped++;
		} else {
			debug(
				`triage: analyze ${session.id} (msgs=${input.messageCount}, turns=${input.turnCount}, dur=${input.durationS}s)`,
			);
			toAnalyze.push(session);
		}
	}

	debug(
		`analyze: ${toAnalyze.length} session(s) to analyze in chunks of ${config.analyze.parallelism}`,
	);
	const chunks = chunkArray(toAnalyze, config.analyze.parallelism);
	let consecutiveFailures = 0;

	for (const chunk of chunks) {
		if (consecutiveFailures >= config.analyze.max_consecutive_failures) {
			debug(
				`circuit breaker: ${consecutiveFailures} consecutive failures, aborting`,
			);
			break;
		}

		const results = await Promise.all(
			chunk.map((session) =>
				analyzeSession(db, session.id, session.parent_id, config),
			),
		);

		for (const r of results) {
			if (r === "complete") {
				result.analyzed++;
				consecutiveFailures = 0;
			} else if (r === "refused") {
				result.refused++;
				consecutiveFailures = 0;
			} else {
				result.errors++;
				consecutiveFailures++;
			}
		}

		if (
			config.analyze.delay_ms > 0 &&
			chunks.indexOf(chunk) < chunks.length - 1
		) {
			await new Promise((r) => setTimeout(r, config.analyze.delay_ms));
		}
	}

	return result;
}

async function analyzeSession(
	db: DuckDBConnection,
	sessionId: string,
	_parentId: string | null,
	config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<"complete" | "refused" | "error"> {
	try {
		await run(
			db,
			"UPDATE analysis SET status = 'processing' WHERE session_id = ?",
			sessionId,
		);

		const prompt = await buildAnalysisPrompt(db, sessionId);
		debug(`session ${sessionId}: prompt built (${prompt.length} chars)`);
		trace(`session ${sessionId}: prompt preview:\n${prompt.slice(0, 500)}`);

		const systemPrompt =
			"You are a coding session analyst. Given a transcript of an AI coding assistant session, produce a structured JSON analysis. Be concise and factual. Focus on what was accomplished, relevant topics, any user frustrations or tool failures, and workflow observations.";

		debug(`session ${sessionId}: querying ${config.analyze.model}`);
		let output: AnalysisOutput | null = null;

		for await (const message of query({
			prompt: `Analyze this coding session transcript:\n\n${prompt}`,
			options: {
				model: config.analyze.model,
				systemPrompt,
				tools: [],
				allowedTools: [],
				thinking: { type: "disabled" },
				persistSession: false,
				settingSources: [],
				maxTurns: 1,
				effort: "low",
				outputFormat: {
					type: "json_schema",
					schema: analysisSchema as Record<string, unknown>,
				},
			},
		})) {
			trace(
				`session ${sessionId}: sdk message type=${message.type}${"subtype" in message ? ` subtype=${message.subtype}` : ""}`,
			);
			if (message.type === "result") {
				if (message.subtype === "success" && message.structured_output) {
					output = message.structured_output as AnalysisOutput;
					debug(
						`session ${sessionId}: analysis complete — ${output.topics.length} topics, ${output.frustrations.length} frustrations`,
					);
					trace(`session ${sessionId}: summary: ${output.summary}`);
				} else {
					debug(`session ${sessionId}: result subtype=${message.subtype}`);
					if (message.subtype !== "success" && message.errors?.length) {
						debug(`session ${sessionId}: errors: ${message.errors.join("; ")}`);
					}
				}
			}
		}

		if (!output) {
			debug(`session ${sessionId}: refused — no structured output`);
			await run(
				db,
				"UPDATE analysis SET status = 'refused', error_reason = 'No structured output returned' WHERE session_id = ?",
				sessionId,
			);
			return "refused";
		}

		await run(
			db,
			`UPDATE analysis SET
				status = 'complete',
				summary = ?,
				topics = ?::JSON::TEXT[],
				frustrations = ?::JSON::TEXT[],
				workflow_notes = ?,
				analyzed_at = now(),
				analyzer_model = ?
			WHERE session_id = ?`,
			output.summary,
			JSON.stringify(output.topics),
			JSON.stringify(output.frustrations),
			output.workflow_notes,
			config.analyze.model,
			sessionId,
		);
		return "complete";
	} catch (err: unknown) {
		debug(`session ${sessionId}: error — ${String(err)}`);
		const retryCount = await all<{ retry_count: number }>(
			db,
			"SELECT retry_count FROM analysis WHERE session_id = ?",
			sessionId,
		);
		const currentRetries = retryCount[0]?.retry_count ?? 0;

		if (currentRetries < config.analyze.max_retries) {
			debug(
				`session ${sessionId}: retry ${currentRetries + 1}/${config.analyze.max_retries} pending`,
			);
			await run(
				db,
				"UPDATE analysis SET status = 'retry_pending', error_reason = ?, retry_count = ? WHERE session_id = ?",
				String(err),
				currentRetries + 1,
				sessionId,
			);
		} else {
			debug(`session ${sessionId}: max retries exhausted, marking error`);
			await run(
				db,
				"UPDATE analysis SET status = 'error', error_reason = ? WHERE session_id = ?",
				String(err),
				sessionId,
			);
		}
		return "error";
	}
}

function chunkArray<T>(arr: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		chunks.push(arr.slice(i, i + size));
	}
	return chunks;
}
