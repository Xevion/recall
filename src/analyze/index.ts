import type duckdb from "duckdb";
import { loadConfig } from "../config";
import { all, run } from "../db/index";
import { buildAnalysisPrompt } from "./prompt";
import { extractResearchArtifact, isResearchByPrompt } from "./research";
import { type AnalysisOutput, analysisSchema } from "./schema";
import { type TriageInput, triageSession } from "./triage";

// TODO: import { query } from "@anthropic-ai/claude-agent-sdk" once SDK types stabilize

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
	db: duckdb.Database,
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

	// Triage
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
			await run(
				db,
				"UPDATE analysis SET status = 'skipped' WHERE session_id = ?",
				session.id,
			);
			result.skipped++;
		} else {
			toAnalyze.push(session);
		}
	}

	// Chunked parallel analysis
	const chunks = chunkArray(toAnalyze, config.analyze.parallelism);
	let consecutiveFailures = 0;

	for (const chunk of chunks) {
		if (consecutiveFailures >= config.analyze.max_consecutive_failures) {
			console.error(
				`Circuit breaker: ${consecutiveFailures} consecutive failures, aborting.`,
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
	db: duckdb.Database,
	sessionId: string,
	parentId: string | null,
	config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<"complete" | "refused" | "error"> {
	try {
		await run(
			db,
			"UPDATE analysis SET status = 'processing' WHERE session_id = ?",
			sessionId,
		);

		const prompt = await buildAnalysisPrompt(db, sessionId);

		// TODO: Replace with actual claude-agent-sdk query() call
		//
		// const { query } = await import("@anthropic-ai/claude-agent-sdk");
		// let lastMessage: AnalysisOutput | null = null;
		// let lastActivity = Date.now();
		//
		// for await (const message of query({
		//   prompt: `Analyze this coding session transcript:\n\n${prompt}`,
		//   options: {
		//     model: config.analyze.model,
		//     systemPrompt: "You are a session analyst...",
		//     tools: [],
		//     allowedTools: [],
		//     thinking: { type: "disabled" },
		//     persistSession: false,
		//     settingSources: [],
		//     outputFormat: { type: "json_schema", schema: analysisSchema },
		//   },
		// })) {
		//   lastActivity = Date.now();
		//   if (message.type === "result" && message.subtype === "success") {
		//     lastMessage = message.structured_output as AnalysisOutput;
		//   }
		// }

		// Placeholder until SDK integration is wired up
		console.log(
			`[analyze] Would analyze session ${sessionId} (${prompt.length} chars)`,
		);
		return "complete";
	} catch (err) {
		const retryCount = await all<{ retry_count: number }>(
			db,
			"SELECT retry_count FROM analysis WHERE session_id = ?",
			sessionId,
		);
		const currentRetries = retryCount[0]?.retry_count ?? 0;

		if (currentRetries < config.analyze.max_retries) {
			await run(
				db,
				"UPDATE analysis SET status = 'retry_pending', error_reason = ?, retry_count = ? WHERE session_id = ?",
				String(err),
				currentRetries + 1,
				sessionId,
			);
		} else {
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
