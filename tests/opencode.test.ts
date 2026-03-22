import { Database as SQLiteDB } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { all } from "../src/db/index";
import { ingestOpenCode } from "../src/ingest/opencode";
import { createTestDb } from "./helpers";

let instance: DuckDBInstance;
let conn: DuckDBConnection;
let tmpDbPath: string;

// Raw SQLite IDs — the parser prefixes these with "oc-" for DuckDB
const RAW_PARENT_ID = "parent-001";
const RAW_CHILD_ID = "child-001";
const PARENT_ID = `oc-${RAW_PARENT_ID}`;
const CHILD_ID = `oc-${RAW_CHILD_ID}`;
const NOW_MS = 1735689600000; // 2025-01-01T00:00:00.000Z
const LATER_MS = NOW_MS + 120_000; // +2 minutes

beforeAll(async () => {
	// Create temporary SQLite with OpenCode schema and synthetic data
	tmpDbPath = join(tmpdir(), `recall-test-oc-${Date.now()}.db`);
	const sqlite = new SQLiteDB(tmpDbPath);

	sqlite.run(`
		CREATE TABLE session (
			id TEXT PRIMARY KEY,
			project_id TEXT,
			parent_id TEXT,
			directory TEXT,
			title TEXT,
			time_created INTEGER,
			time_updated INTEGER
		)
	`);
	sqlite.run(`
		CREATE TABLE message (
			id TEXT PRIMARY KEY,
			session_id TEXT,
			time_created INTEGER,
			time_updated INTEGER,
			data TEXT
		)
	`);
	sqlite.run(`
		CREATE TABLE part (
			id TEXT PRIMARY KEY,
			message_id TEXT,
			session_id TEXT,
			time_created INTEGER,
			time_updated INTEGER,
			data TEXT
		)
	`);

	// Parent session
	sqlite.run("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)", [
		RAW_PARENT_ID,
		"my-project",
		null,
		"/home/user/project",
		"Test session",
		NOW_MS,
		LATER_MS,
	]);
	// Child/subagent session
	sqlite.run("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)", [
		RAW_CHILD_ID,
		"my-project",
		RAW_PARENT_ID,
		"/home/user/project",
		"Sub session",
		NOW_MS + 10_000,
		LATER_MS - 10_000,
	]);

	// Messages for parent: user + assistant
	sqlite.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
		"msg-u1",
		RAW_PARENT_ID,
		NOW_MS,
		NOW_MS,
		JSON.stringify({ role: "user" }),
	]);
	sqlite.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
		"msg-a1",
		RAW_PARENT_ID,
		NOW_MS + 5000,
		NOW_MS + 5000,
		JSON.stringify({
			role: "assistant",
			modelID: "claude-sonnet-4-5",
			tokens: { input: 100, output: 200 },
		}),
	]);

	// Messages for child: user + assistant
	sqlite.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
		"msg-cu1",
		RAW_CHILD_ID,
		NOW_MS + 10_000,
		NOW_MS + 10_000,
		JSON.stringify({ role: "user" }),
	]);
	sqlite.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
		"msg-ca1",
		RAW_CHILD_ID,
		NOW_MS + 15_000,
		NOW_MS + 15_000,
		JSON.stringify({
			role: "assistant",
			modelID: "claude-sonnet-4-5",
			tokens: { input: 50, output: 75 },
		}),
	]);

	// Parts for parent user message: text part
	sqlite.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
		"part-u1",
		"msg-u1",
		RAW_PARENT_ID,
		NOW_MS,
		NOW_MS,
		JSON.stringify({ type: "text", text: "Hello from user" }),
	]);

	// Parts for parent assistant message: text + tool (success)
	sqlite.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
		"part-a1-text",
		"msg-a1",
		RAW_PARENT_ID,
		NOW_MS + 5000,
		NOW_MS + 5000,
		JSON.stringify({ type: "text", text: "Assist response" }),
	]);
	sqlite.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
		"part-a1-tool",
		"msg-a1",
		RAW_PARENT_ID,
		NOW_MS + 5000,
		NOW_MS + 5000,
		JSON.stringify({
			type: "tool",
			callID: "tc-oc-001",
			tool: "read",
			state: { status: "done", input: { path: "/foo" } },
		}),
	]);

	// Parts for parent assistant: tool with error state
	sqlite.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
		"part-a1-tool-err",
		"msg-a1",
		RAW_PARENT_ID,
		NOW_MS + 5000,
		NOW_MS + 5000,
		JSON.stringify({
			type: "tool",
			callID: "tc-oc-err",
			tool: "bash",
			state: { status: "error", input: { command: "exit 1" } },
		}),
	]);

	// Parts for child messages
	sqlite.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
		"part-cu1",
		"msg-cu1",
		RAW_CHILD_ID,
		NOW_MS + 10_000,
		NOW_MS + 10_000,
		JSON.stringify({ type: "text", text: "Sub user msg" }),
	]);
	sqlite.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
		"part-ca1",
		"msg-ca1",
		RAW_CHILD_ID,
		NOW_MS + 15_000,
		NOW_MS + 15_000,
		JSON.stringify({ type: "text", text: "Sub assistant msg" }),
	]);

	sqlite.close();

	// Now ingest into DuckDB
	({ instance, conn } = await createTestDb());
	const result = await ingestOpenCode(conn, tmpDbPath, { force: true });
	expect(result.errors).toEqual([]);
});

afterAll(() => {
	try {
		unlinkSync(tmpDbPath);
	} catch {}
});

describe("opencode ingest", () => {
	test("role and modelID extracted from message.data", async () => {
		const rows = await all<{ role: string; model: string }>(
			conn,
			"SELECT role, model FROM message WHERE id = 'msg-a1'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.role).toBe("assistant");
		expect(rows[0]!.model).toBe("claude-sonnet-4-5");
	});

	test("tokens extracted from message.data.tokens", async () => {
		const rows = await all<{ token_input: number; token_output: number }>(
			conn,
			"SELECT token_input, token_output FROM message WHERE id = 'msg-a1'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.token_input).toBe(100);
		expect(rows[0]!.token_output).toBe(200);
	});

	test("text content extracted from part.data", async () => {
		const rows = await all<{ content: string }>(
			conn,
			"SELECT content FROM message WHERE id = 'msg-u1'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.content).toBe("Hello from user");
	});

	test("tool call extracted from tool part", async () => {
		const rows = await all<{ tool_name: string }>(
			conn,
			"SELECT tool_name FROM tool_call WHERE id = 'tc-oc-001'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.tool_name).toBe("read");
	});

	test("tool error detected via state.status", async () => {
		const rows = await all<{ is_error: boolean }>(
			conn,
			"SELECT is_error FROM tool_call WHERE id = 'tc-oc-err'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.is_error).toBe(true);
	});

	test("subagent session linked via parent_id", async () => {
		const sessions = await all<{ parent_id: string }>(
			conn,
			`SELECT parent_id FROM session WHERE id = '${CHILD_ID}'`,
		);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.parent_id).toBe(PARENT_ID);

		const subagents = await all(
			conn,
			`SELECT session_id FROM subagent WHERE session_id = '${CHILD_ID}'`,
		);
		expect(subagents).toHaveLength(1);
	});

	test("timestamps from time_created (unix ms)", async () => {
		const rows = await all<{ started_at: string }>(
			conn,
			`SELECT started_at FROM session WHERE id = '${PARENT_ID}'`,
		);
		expect(rows).toHaveLength(1);
		const ts = new Date(rows[0]!.started_at);
		expect(ts.getTime()).toBe(NOW_MS);
	});
});
