import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { all } from "../src/db/index";
import { ingestClaudeCode } from "../src/ingest/claude-code";
import { createTestDb } from "./helpers";

let instance: DuckDBInstance;
let conn: DuckDBConnection;

const fixturesDir = join(import.meta.dir, "fixtures", "claude-code");

beforeAll(async () => {
	({ instance, conn } = await createTestDb());
	const result = await ingestClaudeCode(conn, fixturesDir, { force: true });
	// Sanity: ingest should not produce errors
	expect(result.errors).toEqual([]);
});

describe("claude-code ingest", () => {
	test("sessionId extracted past file-history-snapshot", async () => {
		const rows = await all(conn, "SELECT id FROM session WHERE id = 'test-cc-simple'");
		expect(rows).toHaveLength(1);
	});

	test("message count excludes file-history-snapshot and isMeta events", async () => {
		const rows = await all<{ message_count: number }>(
			conn,
			"SELECT message_count FROM session WHERE id = 'test-cc-simple'",
		);
		expect(rows[0]!.message_count).toBe(3);
	});

	test("tool call extracted from assistant content", async () => {
		const rows = await all<{ tool_name: string; input_summary: string }>(
			conn,
			"SELECT tool_name, input_summary FROM tool_call WHERE session_id = 'test-cc-simple'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.tool_name).toBe("Read");
		expect(rows[0]!.input_summary).toBe("file: /x");
	});

	test("tool error detected from user tool_result block", async () => {
		const rows = await all<{ is_error: boolean }>(
			conn,
			"SELECT is_error FROM tool_call WHERE id = 'toolu_001'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.is_error).toBe(true);
	});

	test("snapshot-only file produces no session", async () => {
		const rows = await all(
			conn,
			"SELECT id FROM session WHERE source_path LIKE '%snapshot-only%'",
		);
		expect(rows).toHaveLength(0);
	});

	test("subagent session linked to parent", async () => {
		const sessions = await all<{ parent_id: string }>(
			conn,
			"SELECT parent_id FROM session WHERE id = 'test-cc-subagent'",
		);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.parent_id).toBe("test-cc-parent");

		const subagents = await all(
			conn,
			"SELECT session_id FROM subagent WHERE session_id = 'test-cc-subagent'",
		);
		expect(subagents).toHaveLength(1);
	});

	test(".meta.json populates agentType and description", async () => {
		const rows = await all<{ agent_type: string; description: string }>(
			conn,
			"SELECT agent_type, description FROM subagent WHERE session_id = 'test-cc-subagent'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.agent_type).toBe("research");
		expect(rows[0]!.description).toBe("Test agent");
	});

	test("cwd extracted as project_path", async () => {
		const rows = await all<{ project_path: string }>(
			conn,
			"SELECT project_path FROM session WHERE id = 'test-cc-simple'",
		);
		expect(rows[0]!.project_path).toBe("/projects/test");
	});
});
