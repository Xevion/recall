import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import { withTransaction } from "../db/index";
import type {
	NormalizedMessage,
	NormalizedSession,
	NormalizedToolCall,
} from "./types";

/**
 * Persist a normalized session and all its related records to DuckDB.
 * All inserts are wrapped in a single transaction for atomicity and performance.
 * Prepared statements are reused across loop iterations.
 */
export async function persistSession(
	conn: DuckDBConnection,
	session: NormalizedSession,
): Promise<void> {
	await withTransaction(conn, async (conn) => {
		await conn.run(
			`INSERT OR REPLACE INTO session
			 (id, source, parent_id, project_path, project_name, git_branch, title,
			  started_at, ended_at, message_count, turn_count, token_input, token_output,
			  duration_s, source_path)
			 VALUES ($id, $source, $parent_id, $project_path, $project_name, $git_branch, $title,
			         $started_at, $ended_at, $message_count, $turn_count, $token_input, $token_output,
			         $duration_s, $source_path)`,
			{
				id: session.id,
				source: session.source,
				parent_id: session.parentId,
				project_path: session.projectPath,
				project_name: session.projectName,
				git_branch: session.gitBranch,
				title: session.title,
				started_at: session.startedAt.toISOString(),
				ended_at: session.endedAt?.toISOString() ?? null,
				message_count: session.messageCount,
				turn_count: session.turnCount,
				token_input: session.tokenInput,
				token_output: session.tokenOutput,
				duration_s: session.durationS,
				source_path: session.sourcePath,
			},
		);

		if (session.messages.length > 0) {
			const msgStmt = await conn.prepare(
				`INSERT OR REPLACE INTO message
				 (id, session_id, role, model, seq, timestamp, token_input, token_output,
				  content, has_tool_use)
				 VALUES ($id, $session_id, $role, $model, $seq, $timestamp, $token_input,
				         $token_output, $content, $has_tool_use)`,
			);
			for (const msg of session.messages) {
				msgStmt.bind(buildMessageParams(msg));
				await msgStmt.run();
			}
			msgStmt.destroySync();
		}

		if (session.toolCalls.length > 0) {
			const tcStmt = await conn.prepare(
				`INSERT OR REPLACE INTO tool_call
				 (id, message_id, session_id, tool_name, input_summary, is_error, duration_ms)
				 VALUES ($id, $message_id, $session_id, $tool_name, $input_summary, $is_error, $duration_ms)`,
			);
			for (const tc of session.toolCalls) {
				tcStmt.bind(buildToolCallParams(tc));
				await tcStmt.run();
			}
			tcStmt.destroySync();
		}

		if (session.subagent) {
			const sa = session.subagent;
			await conn.run(
				`INSERT OR REPLACE INTO subagent
				 (session_id, agent_type, description, slug, prompt, result)
				 VALUES ($session_id, $agent_type, $description, $slug, $prompt, $result)`,
				{
					session_id: sa.sessionId,
					agent_type: sa.agentType,
					description: sa.description,
					slug: sa.slug,
					prompt: sa.prompt,
					result: sa.result,
				},
			);
		}

		await conn.run(
			`INSERT INTO analysis (session_id, status) VALUES ($session_id, 'pending')
			 ON CONFLICT DO NOTHING`,
			{ session_id: session.id },
		);
	});
}

function buildMessageParams(msg: NormalizedMessage): Record<string, DuckDBValue> {
	return {
		id: msg.id,
		session_id: msg.sessionId,
		role: msg.role,
		model: msg.model,
		seq: msg.seq,
		timestamp: msg.timestamp?.toISOString() ?? null,
		token_input: msg.tokenInput,
		token_output: msg.tokenOutput,
		content: msg.content,
		has_tool_use: msg.hasToolUse,
	};
}

function buildToolCallParams(tc: NormalizedToolCall): Record<string, DuckDBValue> {
	return {
		id: tc.id,
		message_id: tc.messageId,
		session_id: tc.sessionId,
		tool_name: tc.toolName,
		input_summary: tc.inputSummary,
		is_error: tc.isError,
		duration_ms: tc.durationMs,
	};
}
