import { describe, expect, test } from "bun:test";
import { triageSession } from "../src/analyze/triage";
import type { RecallConfig } from "../src/config";

const defaultTriageConfig: RecallConfig["analyze"]["triage"] = {
	min_messages: 4,
	min_turns: 2,
	min_duration_s: 30,
	require_tool_calls: true,
	auto_analyze_if_subagents: true,
	auto_analyze_min_turns: 10,
	auto_analyze_if_errors: true,
	auto_analyze_min_duration_s: 300,
};

describe("triageSession", () => {
	test("skips tiny sessions below all thresholds", () => {
		const result = triageSession(
			{
				sessionId: "s1",
				messageCount: 1,
				turnCount: 1,
				durationS: 10,
				hasToolCalls: false,
				hasSubagents: false,
				hasErrors: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("skip");
	});

	test("skips sessions with no tool calls when require_tool_calls is true", () => {
		const result = triageSession(
			{
				sessionId: "s2",
				messageCount: 10,
				turnCount: 5,
				durationS: 120,
				hasToolCalls: false,
				hasSubagents: false,
				hasErrors: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("skip");
	});

	test("returns analyze for medium session with tool calls", () => {
		const result = triageSession(
			{
				sessionId: "s3",
				messageCount: 10,
				turnCount: 5,
				durationS: 120,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze");
	});

	test("returns analyze_priority for sessions with subagents", () => {
		const result = triageSession(
			{
				sessionId: "s4",
				messageCount: 2,
				turnCount: 1,
				durationS: 5,
				hasToolCalls: false,
				hasSubagents: true,
				hasErrors: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze_priority");
	});

	test("returns analyze_priority for sessions with errors", () => {
		const result = triageSession(
			{
				sessionId: "s5",
				messageCount: 2,
				turnCount: 1,
				durationS: 5,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: true,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze_priority");
	});

	test("returns analyze_priority for long sessions", () => {
		const result = triageSession(
			{
				sessionId: "s6",
				messageCount: 2,
				turnCount: 1,
				durationS: 400,
				hasToolCalls: false,
				hasSubagents: false,
				hasErrors: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze_priority");
	});

	test("returns analyze_priority for high turn-count sessions", () => {
		const result = triageSession(
			{
				sessionId: "s7",
				messageCount: 30,
				turnCount: 15,
				durationS: 200,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze_priority");
	});
});
