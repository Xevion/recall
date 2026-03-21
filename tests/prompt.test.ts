import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { buildAnalysisPrompt } from "../src/analyze/prompt";
import { ingestClaudeCode } from "../src/ingest/claude-code";
import { createTestDb } from "./helpers";

let conn: DuckDBConnection;

const fixturesDir = join(import.meta.dir, "fixtures", "claude-code");

beforeAll(async () => {
	({ conn } = await createTestDb());
	await ingestClaudeCode(conn, fixturesDir, { force: true });
});

describe("buildAnalysisPrompt", () => {
	test("includes both USER and ASSISTANT labels", async () => {
		const prompt = await buildAnalysisPrompt(conn, "test-cc-realistic");
		expect(prompt).toContain("## USER");
		expect(prompt).toContain("## ASSISTANT");
	});

	test("includes tool call summaries on assistant messages", async () => {
		const prompt = await buildAnalysisPrompt(conn, "test-cc-realistic");
		expect(prompt).toContain("→ Read");
		expect(prompt).toContain("README.md");
	});

	test("includes session context metadata", async () => {
		const prompt = await buildAnalysisPrompt(conn, "test-cc-realistic");
		expect(prompt).toContain("# Session Context");
		expect(prompt).toContain("Branch: feature");
	});

	test("user messages contain tool result summaries", async () => {
		const prompt = await buildAnalysisPrompt(conn, "test-cc-realistic");
		// User tool_result messages should show the tool name and content preview
		expect(prompt).toContain("[Read");
		expect(prompt).toContain("My Project");
	});

	test("thinking blocks appear as markers", async () => {
		const prompt = await buildAnalysisPrompt(conn, "test-cc-realistic");
		expect(prompt).toContain("(thinking)");
	});
});
