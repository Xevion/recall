import { describe, expect, mock, test } from "bun:test";
import {
	analyze,
	type CandidateSession,
	getCandidateSessions,
	tryExtractAnalysisOutput,
} from "../src/analyze/index";
import { all, run } from "../src/db/index";
import { createTestDb } from "./helpers";

const VALID_OUTPUT = {
	title: "Fix parser bug in tokenizer",
	summary:
		"Fixed a parser bug causing incorrect token boundaries. Required tracing through the lexer state machine.",
	outcome: "completed" as const,
	outcome_confidence: "high" as const,
	session_types: ["debugging" as const],
	topics: ["language:typescript", "activity:debugging"],
	frustrations: [],
	actionable_insight: null,
	is_research_subagent: false,
	research_topic: null,
	research_tags: null,
};

describe("tryExtractAnalysisOutput", () => {
	test("extracts valid JSON from plain text", () => {
		const raw = JSON.stringify(VALID_OUTPUT);
		const result = tryExtractAnalysisOutput(raw, "test-1");
		expect(result).toEqual(VALID_OUTPUT);
	});

	test("extracts valid JSON from markdown code fences", () => {
		const raw = `\`\`\`json\n${JSON.stringify(VALID_OUTPUT, null, 2)}\n\`\`\``;
		const result = tryExtractAnalysisOutput(raw, "test-2");
		expect(result).toEqual(VALID_OUTPUT);
	});

	test("extracts valid JSON from code fences without language tag", () => {
		const raw = `\`\`\`\n${JSON.stringify(VALID_OUTPUT)}\n\`\`\``;
		const result = tryExtractAnalysisOutput(raw, "test-3");
		expect(result).toEqual(VALID_OUTPUT);
	});

	test("extracts JSON embedded in surrounding text", () => {
		const raw = `Here is the analysis:\n${JSON.stringify(VALID_OUTPUT)}\n\nLet me know if you need more.`;
		const result = tryExtractAnalysisOutput(raw, "test-4");
		expect(result).toEqual(VALID_OUTPUT);
	});

	test("returns null for invalid JSON", () => {
		const result = tryExtractAnalysisOutput("{ broken json }", "test-5");
		expect(result).toBeNull();
	});

	test("returns null for valid JSON that fails schema validation", () => {
		const raw = JSON.stringify({ summary: "Missing required fields" });
		const result = tryExtractAnalysisOutput(raw, "test-6");
		expect(result).toBeNull();
	});

	test("returns null for text with no JSON object", () => {
		const result = tryExtractAnalysisOutput(
			"The model refused to analyze this session.",
			"test-7",
		);
		expect(result).toBeNull();
	});

	test("returns null for empty string", () => {
		const result = tryExtractAnalysisOutput("", "test-8");
		expect(result).toBeNull();
	});

	test("rejects output with additional properties", () => {
		const withExtra = { ...VALID_OUTPUT, extra_field: "should fail" };
		const raw = JSON.stringify(withExtra);
		const result = tryExtractAnalysisOutput(raw, "test-9");
		expect(result).toBeNull();
	});
});

async function insertSession(
	db: Awaited<ReturnType<typeof createTestDb>>["conn"],
	id: string,
	overrides: {
		project_path?: string;
		project_name?: string;
		started_at?: string;
		analysisStatus?: string;
	} = {},
) {
	await run(
		db,
		`INSERT INTO session (id, source, started_at, message_count, turn_count, duration_s, token_input, token_output, project_path, project_name)
		 VALUES (?, 'claude-code', ?, 10, 5, 300, 1000, 500, ?, ?)`,
		id,
		overrides.started_at ?? "2026-01-15T12:00:00Z",
		overrides.project_path ?? "/home/user/project",
		overrides.project_name ?? "project",
	);
	await run(
		db,
		"INSERT INTO analysis (session_id, status) VALUES (?, ?::analysis_status)",
		id,
		overrides.analysisStatus ?? "pending",
	);
}

describe("getCandidateSessions", () => {
	test("--project filters to matching sessions by project_name", async () => {
		const { conn } = await createTestDb();
		await insertSession(conn, "s1", {
			project_name: "recall",
			project_path: "/home/user/recall",
		});
		await insertSession(conn, "s2", {
			project_name: "other-project",
			project_path: "/home/user/other",
		});

		const results = await getCandidateSessions(conn, { project: "recall" });
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("s1");
	});

	test("--since filters to recent sessions only", async () => {
		const { conn } = await createTestDb();
		await insertSession(conn, "s-old", {
			started_at: "2025-01-01T00:00:00Z",
		});
		await insertSession(conn, "s-new", {
			started_at: "2026-03-01T00:00:00Z",
		});

		const results = await getCandidateSessions(conn, {
			since: "2026-02-01T00:00:00Z",
		});
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("s-new");
	});

	test("filters compose: --project + --since together", async () => {
		const { conn } = await createTestDb();
		await insertSession(conn, "s1", {
			project_name: "recall",
			project_path: "/home/user/recall",
			started_at: "2025-01-01T00:00:00Z",
		});
		await insertSession(conn, "s2", {
			project_name: "recall",
			project_path: "/home/user/recall",
			started_at: "2026-03-01T00:00:00Z",
		});
		await insertSession(conn, "s3", {
			project_name: "other",
			project_path: "/home/user/other",
			started_at: "2026-03-01T00:00:00Z",
		});

		const results = await getCandidateSessions(conn, {
			project: "recall",
			since: "2026-02-01T00:00:00Z",
		});
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("s2");
	});

	test("only returns pending/retry_pending sessions", async () => {
		const { conn } = await createTestDb();
		await insertSession(conn, "s-pending", { analysisStatus: "pending" });
		await insertSession(conn, "s-retry", {
			analysisStatus: "retry_pending",
		});
		await insertSession(conn, "s-complete", { analysisStatus: "complete" });
		await insertSession(conn, "s-skipped", { analysisStatus: "skipped" });
		await insertSession(conn, "s-error", { analysisStatus: "error" });

		const results = await getCandidateSessions(conn, {});
		const ids = results.map((r) => r.id);
		expect(ids).toContain("s-pending");
		expect(ids).toContain("s-retry");
		expect(ids).not.toContain("s-complete");
		expect(ids).not.toContain("s-skipped");
		expect(ids).not.toContain("s-error");
	});

	test("orders by started_at DESC (most recent first)", async () => {
		const { conn } = await createTestDb();
		await insertSession(conn, "s-oldest", {
			started_at: "2026-01-01T00:00:00Z",
		});
		await insertSession(conn, "s-middle", {
			started_at: "2026-02-01T00:00:00Z",
		});
		await insertSession(conn, "s-newest", {
			started_at: "2026-03-01T00:00:00Z",
		});

		const results = await getCandidateSessions(conn, {});
		expect(results.map((r) => r.id)).toEqual([
			"s-newest",
			"s-middle",
			"s-oldest",
		]);
	});
});

describe("analyze dry-run", () => {
	test("returns count of sessions to analyze without calling LLM", async () => {
		const { conn } = await createTestDb();
		// Insert sessions that pass triage (enough messages/turns/duration/tool_calls)
		await insertSession(conn, "s-analyze-1", {});
		await insertSession(conn, "s-analyze-2", {});
		// Insert messages and tool calls so triage passes require_tool_calls
		await run(
			conn,
			"INSERT INTO message (id, session_id, role, content, seq) VALUES ('m1', 's-analyze-1', 'assistant', 'hello', 1)",
		);
		await run(
			conn,
			"INSERT INTO message (id, session_id, role, content, seq) VALUES ('m2', 's-analyze-2', 'assistant', 'hello', 1)",
		);
		await run(
			conn,
			"INSERT INTO tool_call (id, message_id, session_id, tool_name, is_error) VALUES ('tc1', 'm1', 's-analyze-1', 'Read', false)",
		);
		await run(
			conn,
			"INSERT INTO tool_call (id, message_id, session_id, tool_name, is_error) VALUES ('tc2', 'm2', 's-analyze-2', 'Read', false)",
		);

		const result = await analyze(conn, { dryRun: true });

		// Sessions should be counted as "to analyze" but not actually processed
		expect(result.analyzed).toBe(2);
		expect(result.errors).toBe(0);
		expect(result.refused).toBe(0);

		// Verify no sessions were marked as 'processing' or 'complete'
		const statuses = await all<{ session_id: string; status: string }>(
			conn,
			"SELECT session_id, status FROM analysis WHERE session_id IN ('s-analyze-1', 's-analyze-2')",
		);
		for (const s of statuses) {
			expect(s.status).not.toBe("processing");
			expect(s.status).not.toBe("complete");
		}
	});

	test("dry-run still marks trivial sessions as skipped", async () => {
		const { conn } = await createTestDb();
		// Insert a trivial session (low message count, no tool calls)
		await run(
			conn,
			`INSERT INTO session (id, source, started_at, message_count, turn_count, duration_s, token_input, token_output)
			 VALUES ('s-trivial', 'claude-code', '2026-01-15T12:00:00Z', 2, 1, 10, 100, 50)`,
		);
		await run(
			conn,
			"INSERT INTO analysis (session_id, status) VALUES ('s-trivial', 'pending')",
		);

		const result = await analyze(conn, { dryRun: true });

		expect(result.skipped).toBe(1);
		expect(result.analyzed).toBe(0);

		// Verify it was marked skipped in the DB
		const rows = await all<{ status: string }>(
			conn,
			"SELECT status FROM analysis WHERE session_id = 's-trivial'",
		);
		expect(rows[0]!.status).toBe("skipped");
	});
});
