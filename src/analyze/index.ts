import { query } from "@anthropic-ai/claude-agent-sdk";
import type { DuckDBConnection } from "@duckdb/node-api";
import { getLogger } from "@logtape/logtape";
import Ajv from "ajv/dist/2020";
import { loadConfig } from "../config";
import { all, run } from "../db/index";
import { escapeLike } from "../db/queries";
import { runPool } from "../utils/pool";
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

const SYSTEM_PROMPT = `You are a coding session analyst. Given a transcript of an AI coding assistant session, produce a structured JSON analysis.

Rules:
- title: One phrase, under 80 characters, no period. Like a git commit subject.
- summary: 1-2 sentences, under 40 words. First sentence: what was accomplished (not how). Second sentence: the single most important challenge, decision, or blocker — omit if the session was straightforward.
- outcome: Relative to the session's apparent intent. Exploratory sessions that answered the question = completed. Planning sessions that produced a plan = completed.
- outcome_confidence: 'high' = clear intent and clear resolution. 'medium' = intent is clear but outcome is ambiguous (e.g., work was done but unclear if the user was satisfied). 'low' = session intent itself is unclear, or the transcript is too truncated to judge.
- session_types: What kind of work, not what tools were used. Use multiple if the session pivoted.
- topics: Use the provided vocabulary. Format as "category:tag". Mint new tags within a category only when nothing fits.
- frustrations: Only include genuine frustrations. Categorize precisely:
  - tool_failure: Tool errors, retries, crashes
  - user_correction: User corrected the assistant's approach or output
  - external_blocker: Rate limits, missing permissions, network issues
  - workflow_antipattern: Inefficient patterns (sequential reads, not checking --help, unnecessary re-reads)
  Omit frustrations that are routine infrastructure noise: ToolSearch needing multiple calls to resolve, single WebFetch timeouts that were retried successfully, transient MCP tool errors. Only report frustrations that visibly cost turns, required backtracking, or blocked progress.
- actionable_insight: One concrete sentence for future sessions. Null if nothing novel. Must not restate what's already in the summary or frustrations.
- Be concise and factual. Do not pad fields to fill space.`;

const SUBAGENT_SYSTEM_PROMPT = `You are a coding session analyst. Given a transcript of a subagent session (a child process dispatched by a parent AI assistant), produce a structured JSON analysis.

For subagent sessions, focus on:
- title: What the subagent was tasked to do, one phrase
- summary: What it found or accomplished, 2 sentences
- outcome: Did it answer the parent's question / complete the delegated task?
- topics: Use the provided vocabulary, "category:tag" format
- frustrations: Empty array (subagent friction is rarely actionable)
- actionable_insight: Always null for subagents
- is_research_subagent: True if the subagent was doing research/exploration

Be concise.`;

export interface CandidateSession {
	id: string;
	message_count: number;
	turn_count: number;
	duration_s: number;
	parent_id: string | null;
	has_tool_calls: boolean;
	has_subagents: boolean;
	has_errors: boolean;
}

export interface AnalyzeOptions {
	limit?: number;
	force?: string;
	project?: string;
	since?: string;
	dryRun?: boolean;
}

export interface AnalyzeResult {
	analyzed: number;
	skipped: number;
	errors: number;
	refused: number;
}

const CANDIDATE_SELECT = `SELECT s.id, s.message_count, s.turn_count, s.duration_s, s.parent_id,
	   EXISTS(SELECT 1 FROM tool_call WHERE session_id = s.id) as has_tool_calls,
	   EXISTS(SELECT 1 FROM session c WHERE c.parent_id = s.id) as has_subagents,
	   EXISTS(SELECT 1 FROM tool_call WHERE session_id = s.id AND is_error = TRUE) as has_errors
	 FROM session s
	 JOIN analysis a ON s.id = a.session_id`;

export async function getCandidateSessions(
	db: DuckDBConnection,
	opts: Pick<AnalyzeOptions, "limit" | "project" | "since">,
): Promise<CandidateSession[]> {
	const conditions: string[] = ["a.status IN ('pending', 'retry_pending')"];
	const params: unknown[] = [];

	if (opts.project) {
		const escaped = escapeLike(opts.project);
		conditions.push(
			"(s.project_name ILIKE ? ESCAPE '\\' OR s.project_path ILIKE ? ESCAPE '\\')",
		);
		params.push(`%${escaped}%`, `%${escaped}%`);
	}

	if (opts.since) {
		conditions.push("s.started_at >= ?");
		params.push(opts.since);
	}

	const where =
		conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
	const sql = `${CANDIDATE_SELECT}${where} ORDER BY s.started_at DESC LIMIT ?`;
	params.push(opts.limit ?? 100);

	return all<CandidateSession>(db, sql, ...params);
}

export async function analyze(
	db: DuckDBConnection,
	opts: AnalyzeOptions,
	signal?: AbortSignal,
): Promise<AnalyzeResult> {
	const config = await loadConfig();
	const result: AnalyzeResult = {
		analyzed: 0,
		skipped: 0,
		errors: 0,
		refused: 0,
	};

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
		logger.info("Recovering {count} orphaned 'processing' session(s)", {
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
		await run(
			db,
			"UPDATE analysis SET status = 'pending', retry_count = 0 WHERE session_id = ?",
			opts.force,
		);
	} else {
		sessions = await getCandidateSessions(db, opts);
	}

	logger.info("{count} candidate session(s) found", {
		count: sessions.length,
	});

	const toAnalyze: CandidateSession[] = [];
	for (const session of sessions) {
		const isSubagent = session.parent_id != null;
		const input: TriageInput = {
			sessionId: session.id,
			messageCount: session.message_count ?? 0,
			turnCount: session.turn_count ?? 0,
			durationS: session.duration_s ?? 0,
			hasToolCalls: session.has_tool_calls,
			hasSubagents: session.has_subagents,
			hasErrors: session.has_errors,
			isSubagent,
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

	if (opts.dryRun) {
		result.analyzed = toAnalyze.length;
		return result;
	}

	logger.info("{count} session(s) to analyze (parallelism={parallelism})", {
		count: toAnalyze.length,
		parallelism: config.analyze.parallelism,
	});

	let completedCount = 0;
	const totalToAnalyze = toAnalyze.length;

	const onProgress = (
		sessionId: string,
		outcome: string,
		topicCount: number,
	) => {
		completedCount++;
		logger.info(
			"Analyzed {current}/{total}: {sessionId} ({outcome}, {topics} topics)",
			{
				current: completedCount,
				total: totalToAnalyze,
				sessionId: sessionId.slice(0, 8),
				outcome,
				topics: topicCount,
			},
		);
	};

	const tasks = toAnalyze.map((session) => {
		return () =>
			analyzeSession(db, session.id, session.parent_id, config, onProgress);
	});

	let consecutiveFailures = 0;

	const poolResults = await runPool(tasks, config.analyze.parallelism, {
		signal,
		delayMs: config.analyze.delay_ms > 0 ? config.analyze.delay_ms : undefined,
		onTaskComplete: (pr, _idx) => {
			if (pr.status === "ok") {
				const r = pr.value;
				if (r === "complete") {
					consecutiveFailures = 0;
				} else if (r === "refused") {
					consecutiveFailures = 0;
				} else {
					consecutiveFailures++;
				}
			} else {
				consecutiveFailures++;
			}

			if (consecutiveFailures >= config.analyze.max_consecutive_failures) {
				logger.warn(
					"Circuit breaker: {failures} consecutive failures, stopping analysis",
					{ failures: consecutiveFailures },
				);
				return false;
			}
			return true;
		},
	});

	for (const pr of poolResults) {
		if (pr.status === "skipped") continue;
		if (pr.status === "ok") {
			if (pr.value === "complete") result.analyzed++;
			else if (pr.value === "refused") result.refused++;
			else result.errors++;
		} else {
			result.errors++;
		}
	}

	return result;
}

async function analyzeSession(
	db: DuckDBConnection,
	sessionId: string,
	parentId: string | null,
	config: Awaited<ReturnType<typeof loadConfig>>,
	onProgress?: (sessionId: string, outcome: string, topicCount: number) => void,
): Promise<"complete" | "refused" | "error"> {
	const isSubagent = parentId != null;

	try {
		await run(
			db,
			"UPDATE analysis SET status = 'processing' WHERE session_id = ?",
			sessionId,
		);

		const prompt = await buildAnalysisPrompt(db, sessionId, isSubagent);
		logger.debug("Session {sessionId}: prompt built ({chars} chars)", {
			sessionId,
			chars: prompt.length,
		});
		logger.trace("Session {sessionId}: prompt preview:\n{preview}", {
			sessionId,
			preview: truncate(prompt, 1000),
		});

		const systemPrompt = isSubagent ? SUBAGENT_SYSTEM_PROMPT : SYSTEM_PROMPT;

		logger.debug(
			"Session {sessionId}: querying {model} (subagent={isSubagent})",
			{
				sessionId,
				model: config.analyze.model,
				isSubagent,
			},
		);
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
							"Session {sessionId}: analysis complete — {topics} topics, {frustrations} frustrations, outcome={outcome}",
							{
								sessionId,
								topics: output.topics.length,
								frustrations: output.frustrations.length,
								outcome: output.outcome,
							},
						);
						logger.trace("Session {sessionId}: title: {title}", {
							sessionId,
							title: output.title,
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
				logger.warn("Session {sessionId}: model refused", {
					sessionId: sessionId.slice(0, 8),
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
				title = ?,
				summary = ?,
				outcome = ?,
				outcome_confidence = ?,
				session_types = ?::JSON::TEXT[],
				topics = ?::JSON::TEXT[],
				frustrations = ?::JSON,
				actionable_insight = ?,
				analyzed_at = now(),
				analyzer_model = ?
			WHERE session_id = ?`,
			output.title,
			output.summary,
			output.outcome,
			output.outcome_confidence,
			JSON.stringify(output.session_types),
			JSON.stringify(output.topics),
			JSON.stringify(output.frustrations),
			output.actionable_insight,
			config.analyze.model,
			sessionId,
		);
		onProgress?.(sessionId, output.outcome, output.topics.length);
		return "complete";
	} catch (err: unknown) {
		logger.warn("Session {sessionId}: error — {error}", {
			sessionId: sessionId.slice(0, 8),
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
			logger.warn("Session {sessionId}: max retries exhausted", {
				sessionId: sessionId.slice(0, 8),
				max: config.analyze.max_retries,
			});
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

function truncate(s: string, maxLen: number): string {
	return s.length > maxLen ? `${s.slice(0, maxLen)} [truncated]` : s;
}
