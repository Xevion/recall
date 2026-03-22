import { describe, expect, test } from "bun:test";
import { all, run } from "../src/db/index";
import {
	type GetProjectContextOpts,
	getProjectContext,
} from "../src/db/queries";
import { createTestDb } from "./helpers";

type TestDb = Awaited<ReturnType<typeof createTestDb>>["conn"];

async function insertAnalyzedSession(
	db: TestDb,
	id: string,
	opts: {
		project_path?: string;
		project_name?: string;
		started_at?: string;
		parent_id?: string | null;
		message_count?: number;
		turn_count?: number;
		duration_s?: number;
		analysis_status?: string;
		title?: string;
		summary?: string;
		outcome?: string;
		outcome_confidence?: string;
		session_types?: string[];
		topics?: string[];
		frustrations?: {
			category: string;
			description: string;
			severity: string;
		}[];
		actionable_insight?: string | null;
	} = {},
) {
	await run(
		db,
		`INSERT INTO session (id, source, parent_id, started_at, message_count, turn_count, duration_s, token_input, token_output, project_path, project_name)
		 VALUES (?, 'claude-code', ?, ?, ?, ?, ?, 1000, 500, ?, ?)`,
		id,
		opts.parent_id ?? null,
		opts.started_at ?? "2026-01-15T12:00:00Z",
		opts.message_count ?? 10,
		opts.turn_count ?? 5,
		opts.duration_s ?? 300,
		opts.project_path ?? "/home/user/projects/recall",
		opts.project_name ?? "recall",
	);
	await run(
		db,
		`INSERT INTO analysis (session_id, status, title, summary, outcome, outcome_confidence, session_types, topics, frustrations, actionable_insight)
		 VALUES (?, ?::analysis_status, ?, ?, ?, ?, ?::JSON::TEXT[], ?::JSON::TEXT[], ?::JSON, ?)`,
		id,
		opts.analysis_status ?? "complete",
		opts.title ?? "Test session",
		opts.summary ?? "A test session summary",
		opts.outcome ?? "completed",
		opts.outcome_confidence ?? "high",
		JSON.stringify(opts.session_types ?? ["implementation"]),
		JSON.stringify(opts.topics ?? ["language:typescript"]),
		JSON.stringify(opts.frustrations ?? []),
		opts.actionable_insight ?? null,
	);
}

describe("getProjectContext", () => {
	test("returns recent analyzed sessions for the project", async () => {
		const { conn } = await createTestDb();
		await insertAnalyzedSession(conn, "s1", {
			project_name: "recall",
			project_path: "/home/user/projects/recall",
			started_at: "2026-03-01T10:00:00Z",
			title: "First recall session",
		});
		await insertAnalyzedSession(conn, "s2", {
			project_name: "recall",
			project_path: "/home/user/projects/recall",
			started_at: "2026-03-02T10:00:00Z",
			title: "Second recall session",
		});
		await insertAnalyzedSession(conn, "s3", {
			project_name: "glint",
			project_path: "/home/user/projects/glint",
			started_at: "2026-03-01T10:00:00Z",
			title: "Glint session",
		});

		const result = await getProjectContext(conn, { project: "recall" });

		expect(result.project).toBe("recall");
		expect(result.session_count).toBe(2);
		expect(result.sessions).toHaveLength(2);
		// Most recent first
		expect(result.sessions[0]!.title).toBe("Second recall session");
		expect(result.sessions[1]!.title).toBe("First recall session");
		// Glint session should not be included
		const ids = result.sessions.map((s) => s.id);
		expect(ids).not.toContain("s3");
	});

	test("respects --since filter", async () => {
		const { conn } = await createTestDb();
		await insertAnalyzedSession(conn, "s-old", {
			started_at: "2025-06-01T00:00:00Z",
		});
		await insertAnalyzedSession(conn, "s-new", {
			started_at: "2026-03-01T00:00:00Z",
		});

		const result = await getProjectContext(conn, {
			project: "recall",
			since: "2026-01-01T00:00:00Z",
		});

		expect(result.session_count).toBe(1);
		expect(result.sessions[0]!.id).toBe("s-new");
	});

	test("respects --limit", async () => {
		const { conn } = await createTestDb();
		for (let i = 0; i < 5; i++) {
			await insertAnalyzedSession(conn, `s-${i}`, {
				started_at: `2026-03-0${i + 1}T10:00:00Z`,
			});
		}

		const result = await getProjectContext(conn, {
			project: "recall",
			limit: 3,
		});

		expect(result.session_count).toBe(3);
		expect(result.sessions).toHaveLength(3);
	});

	test("only includes analyzed sessions", async () => {
		const { conn } = await createTestDb();
		await insertAnalyzedSession(conn, "s-complete", {
			analysis_status: "complete",
			title: "Complete session",
		});
		await insertAnalyzedSession(conn, "s-pending", {
			analysis_status: "pending",
			title: "Pending session",
		});

		const result = await getProjectContext(conn, { project: "recall" });

		expect(result.session_count).toBe(1);
		expect(result.sessions[0]!.id).toBe("s-complete");
		expect(result.unanalyzed_count).toBe(1);
	});

	test("includes frustrations and actionable insights", async () => {
		const { conn } = await createTestDb();
		const frustrations = [
			{
				category: "tool_failure",
				description: "Grep tool returned empty results",
				severity: "medium",
			},
			{
				category: "user_correction",
				description: "Wrong file path assumed",
				severity: "low",
			},
		];
		await insertAnalyzedSession(conn, "s-frustr", {
			frustrations,
			actionable_insight: "Check file paths before reading",
		});

		const result = await getProjectContext(conn, { project: "recall" });

		expect(result.sessions).toHaveLength(1);
		const session = result.sessions[0]!;
		expect(session.frustrations).toHaveLength(2);
		expect(session.frustrations[0]!.category).toBe("tool_failure");
		expect(session.frustrations[1]!.description).toBe(
			"Wrong file path assumed",
		);
		expect(session.actionable_insight).toBe("Check file paths before reading");
	});

	test("aggregates topic frequency", async () => {
		const { conn } = await createTestDb();
		await insertAnalyzedSession(conn, "s-t1", {
			topics: ["language:typescript", "activity:debugging", "tool:vitest"],
			started_at: "2026-03-01T10:00:00Z",
		});
		await insertAnalyzedSession(conn, "s-t2", {
			topics: ["language:typescript", "tool:duckdb"],
			started_at: "2026-03-02T10:00:00Z",
		});

		const result = await getProjectContext(conn, { project: "recall" });

		expect(result.topic_frequency["language:typescript"]).toBe(2);
		expect(result.topic_frequency["activity:debugging"]).toBe(1);
		expect(result.topic_frequency["tool:vitest"]).toBe(1);
		expect(result.topic_frequency["tool:duckdb"]).toBe(1);
	});
});
