import { query } from "@anthropic-ai/claude-agent-sdk";
import type { DuckDBConnection } from "@duckdb/node-api";
import { getLogger } from "@logtape/logtape";
import Ajv from "ajv/dist/2020";
import { loadConfig } from "../config";
import { all, run } from "../db/index";
import { buildAnalysisPrompt } from "./prompt";
import { type AnalysisOutput, analysisSchema } from "./schema";
import { type TriageInput, triageSession } from "./triage";

const logger = getLogger(["recall", "analyze"]);

const ajv = new Ajv();
const validateAnalysisOutput = ajv.compile<AnalysisOutput>(analysisSchema);

/** Strip $schema directive — the SDK doesn't support it and may silently fall back to prose */
function stripSchemaDirective(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const { $schema: _, ...rest } = schema;
	return rest;
}

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

	interface CandidateSession {
		id: string;
		message_count: number;
		turn_count: number;
		duration_s: number;
		parent_id: string | null;
		has_tool_calls: boolean;
		has_subagents: boolean;
		has_errors: boolean;
	}

	let sessions: CandidateSession[];

	logger.debug("Starting analysis: limit={limit}, force={force}", {
		limit: opts.limit ?? 100,
		force: opts.force ?? "none",
	});

	// Recover orphaned "processing" states from crashed runs
	const recovered = await all<{ cnt: number }>(
		db,
		"SELECT count(*)::INT as cnt FROM analysis WHERE status = 'processing'",
	);
	const staleProcessing = recovered[0]?.cnt ?? 0;
	if (staleProcessing > 0) {
		logger.debug("Recovering {count} orphaned 'processing' session(s)", {
			count: staleProcessing,
		});
		await run(
			db,
			"UPDATE analysis SET status = 'pending' WHERE status = 'processing'",
		);
	}

	if (opts.force) {
		sessions = await all<CandidateSession>(
			db,
			`SELECT s.id, s.message_count, s.turn_count, s.duration_s, s.parent_id,
			   EXISTS(SELECT 1 FROM tool_call WHERE session_id = s.id) as has_tool_calls,
			   EXISTS(SELECT 1 FROM session c WHERE c.parent_id = s.id) as has_subagents,
			   EXISTS(SELECT 1 FROM tool_call WHERE session_id = s.id AND is_error = TRUE) as has_errors
			 FROM session s WHERE s.id = ?`,
			opts.force,
		);
		// Reset analysis status
		await run(
			db,
			"UPDATE analysis SET status = 'pending', retry_count = 0 WHERE session_id = ?",
			opts.force,
		);
	} else {
		sessions = await all<CandidateSession>(
			db,
			`SELECT s.id, s.message_count, s.turn_count, s.duration_s, s.parent_id,
			   EXISTS(SELECT 1 FROM tool_call WHERE session_id = s.id) as has_tool_calls,
			   EXISTS(SELECT 1 FROM session c WHERE c.parent_id = s.id) as has_subagents,
			   EXISTS(SELECT 1 FROM tool_call WHERE session_id = s.id AND is_error = TRUE) as has_errors
			 FROM session s
			 JOIN analysis a ON s.id = a.session_id
			 WHERE a.status IN ('pending', 'retry_pending')
			 ORDER BY s.started_at DESC
			 LIMIT ?`,
			opts.limit ?? 100,
		);
	}

	logger.debug("{count} candidate session(s) found", {
		count: sessions.length,
	});

	const toAnalyze: CandidateSession[] = [];
	for (const session of sessions) {
		const input: TriageInput = {
			sessionId: session.id,
			messageCount: session.message_count ?? 0,
			turnCount: session.turn_count ?? 0,
			durationS: session.duration_s ?? 0,
			hasToolCalls: session.has_tool_calls,
			hasSubagents: session.has_subagents,
			hasErrors: session.has_errors,
		};

		const decision = triageSession(input, config.analyze.triage);
		if (decision === "skip") {
			logger.debug("Triage skip {sessionId}", {
				sessionId: session.id,
				msgs: input.messageCount,
				turns: input.turnCount,
				dur: input.durationS,
			});
			await run(
				db,
				"UPDATE analysis SET status = 'skipped' WHERE session_id = ?",
				session.id,
			);
			result.skipped++;
		} else {
			logger.debug("Triage analyze {sessionId}", {
				sessionId: session.id,
				msgs: input.messageCount,
				turns: input.turnCount,
				dur: input.durationS,
			});
			toAnalyze.push(session);
		}
	}

	logger.debug("{count} session(s) to analyze in chunks of {parallelism}", {
		count: toAnalyze.length,
		parallelism: config.analyze.parallelism,
	});
	const chunks = chunkArray(toAnalyze, config.analyze.parallelism);
	let consecutiveFailures = 0;

	for (let i = 0; i < chunks.length; i++) {
		if (consecutiveFailures >= config.analyze.max_consecutive_failures) {
			logger.debug(
				"Circuit breaker: {failures} consecutive failures, aborting",
				{ failures: consecutiveFailures },
			);
			break;
		}

		const chunk = chunks[i];
		if (!chunk) continue;
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

		if (config.analyze.delay_ms > 0 && i < chunks.length - 1) {
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
		logger.debug("Session {sessionId}: prompt built ({chars} chars)", {
			sessionId,
			chars: prompt.length,
		});
		logger.trace("Session {sessionId}: prompt preview:\n{preview}", {
			sessionId,
			preview: truncate(prompt, 1000),
		});

		const systemPrompt =
			"You are a coding session analyst. Given a transcript of an AI coding assistant session, produce a structured JSON analysis. Be concise and factual. Focus on what was accomplished, relevant topics, any user frustrations or tool failures, and workflow observations.";

		logger.debug("Session {sessionId}: querying {model}", {
			sessionId,
			model: config.analyze.model,
		});
		let output: AnalysisOutput | null = null;
		let rawResultText: string | null = null;

		for await (const message of query({
			prompt: `Analyze this coding session transcript:\n\n${prompt}`,
			options: {
				model: config.analyze.model,
				systemPrompt,
				thinking: { type: "disabled" },
				persistSession: false,
				settingSources: [],
				maxTurns: 4,
				effort: "low",
				permissionMode: "dontAsk",
				outputFormat: {
					type: "json_schema",
					schema: stripSchemaDirective(analysisSchema),
				},
			},
		})) {
			logger.trace("Session {sessionId}: sdk message type={type}{subtype}", {
				sessionId,
				type: message.type,
				subtype: "subtype" in message ? ` subtype=${message.subtype}` : "",
			});
			if (message.type === "result") {
				if (message.subtype === "success") {
					rawResultText = message.result;
					if (message.structured_output) {
						output = message.structured_output as AnalysisOutput;
						logger.debug(
							"Session {sessionId}: analysis complete — {topics} topics, {frustrations} frustrations",
							{
								sessionId,
								topics: output.topics.length,
								frustrations: output.frustrations.length,
							},
						);
						logger.trace("Session {sessionId}: summary: {summary}", {
							sessionId,
							summary: output.summary,
						});
					} else {
						logger.debug(
							"Session {sessionId}: success but no structured_output",
							{ sessionId },
						);
						logger.trace("Session {sessionId}: raw result: {result}", {
							sessionId,
							result: truncate(message.result, 1000),
						});
					}
				} else {
					logger.debug("Session {sessionId}: result subtype={subtype}", {
						sessionId,
						subtype: message.subtype,
					});
					if (message.errors?.length) {
						logger.debug("Session {sessionId}: errors: {errors}", {
							sessionId,
							errors: message.errors.join("; "),
						});
					}
				}
			} else if (message.type === "rate_limit_event") {
				const info = message.rate_limit_info;
				const pct =
					info.utilization != null
						? `${Math.round(info.utilization * 100)}%`
						: "?";
				const resets = info.resetsAt
					? new Date(info.resetsAt * 1000).toISOString()
					: "?";
				logger.debug(
					"Session {sessionId}: rate limit status={status} utilization={pct}",
					{ sessionId, status: info.status, pct },
				);
				logger.trace(
					"Session {sessionId}: rate limit type={type} resets={resets}",
					{
						sessionId,
						type: info.rateLimitType ?? "?",
						resets,
					},
				);
				if (info.status === "allowed_warning") {
					logger.warn("Rate limit warning: {pct} utilized, resets {resets}", {
						pct,
						resets,
					});
				} else if (info.status === "rejected") {
					logger.error(
						"Rate limit rejected: {type} quota exhausted, resets {resets}",
						{ type: info.rateLimitType ?? "unknown", resets },
					);
				}
			}
		}

		if (!output && rawResultText) {
			output = tryExtractAnalysisOutput(rawResultText, sessionId);
		}

		if (!output) {
			const raw = rawResultText ?? "";
			const isRefusal =
				rawResultText != null &&
				/\b(i can't|i cannot|i'm unable|refuse|inappropriate|not appropriate)\b/i.test(
					rawResultText,
				);

			if (isRefusal) {
				const reason = `Model refused: ${truncate(raw, 500)}`;
				logger.debug("Session {sessionId}: refused — {reason}", {
					sessionId,
					reason: truncate(reason, 200),
				});
				await run(
					db,
					"UPDATE analysis SET status = 'refused', error_reason = ? WHERE session_id = ?",
					reason,
					sessionId,
				);
				return "refused";
			}

			const reason = rawResultText
				? `No structured output. Raw: ${truncate(raw, 500)}`
				: "No structured output returned";
			logger.debug("Session {sessionId}: no output — {reason}", {
				sessionId,
				reason: truncate(reason, 200),
			});
			throw new Error(reason);
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
		logger.debug("Session {sessionId}: error — {error}", {
			sessionId,
			error: String(err),
		});
		const retryCount = await all<{ retry_count: number }>(
			db,
			"SELECT retry_count FROM analysis WHERE session_id = ?",
			sessionId,
		);
		const currentRetries = retryCount[0]?.retry_count ?? 0;

		if (currentRetries < config.analyze.max_retries) {
			logger.debug("Session {sessionId}: retry {current}/{max} pending", {
				sessionId,
				current: currentRetries + 1,
				max: config.analyze.max_retries,
			});
			await run(
				db,
				"UPDATE analysis SET status = 'retry_pending', error_reason = ?, retry_count = ? WHERE session_id = ?",
				String(err),
				currentRetries + 1,
				sessionId,
			);
		} else {
			logger.debug(
				"Session {sessionId}: max retries exhausted, marking error",
				{ sessionId },
			);
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

/**
 * Fallback: extract and validate analysis JSON from raw result text.
 * Handles responses where the model emitted JSON as text (possibly code-fenced)
 * instead of calling the SDK's StructuredOutput tool.
 */
export function tryExtractAnalysisOutput(
	raw: string,
	sessionId: string,
): AnalysisOutput | null {
	const stripped = raw
		.replace(/^```(?:json)?\s*\n?/m, "")
		.replace(/\n?```\s*$/m, "");

	const jsonMatch = stripped.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		logger.debug(
			"Session {sessionId}: fallback — no JSON object found in raw text",
			{ sessionId },
		);
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonMatch[0]);
	} catch {
		logger.debug("Session {sessionId}: fallback — JSON.parse failed", {
			sessionId,
		});
		return null;
	}

	if (validateAnalysisOutput(parsed)) {
		logger.debug(
			"Session {sessionId}: fallback — valid analysis extracted ({topics} topics)",
			{ sessionId, topics: (parsed as AnalysisOutput).topics.length },
		);
		return parsed;
	}

	const errors = validateAnalysisOutput.errors
		?.map((e) => `${e.instancePath || "root"}: ${e.message}`)
		.join(", ");
	logger.debug(
		"Session {sessionId}: fallback — schema validation failed: {errors}",
		{ sessionId, errors },
	);
	return null;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		chunks.push(arr.slice(i, i + size));
	}
	return chunks;
}

function truncate(s: string, maxLen: number): string {
	return s.length > maxLen ? `${s.slice(0, maxLen)} [truncated]` : s;
}
