import { describe, expect, test } from "bun:test";
import { triageSession } from "../src/analyze/triage";
import type { RecallConfig } from "../src/config";

const defaultTriageConfig: RecallConfig["analyze"]["triage"] = {
	parent_thresholds: {
		min_messages: 8,
		min_turns: 3,
		min_duration_s: 45,
		require_tool_calls: true,
	},
	subagent_thresholds: {
		min_messages: 6,
		min_turns: 1,
		min_duration_s: 30,
		require_tool_calls: true,
	},
	auto_analyze_if_subagents: true,
	auto_analyze_min_turns: 10,
	auto_analyze_if_errors: true,
	auto_analyze_min_duration_s: 300,
};

describe("triageSession — parent sessions (OR-based skip)", () => {
	test("skips when messages below threshold", () => {
		const result = triageSession(
			{
				sessionId: "s1",
				messageCount: 4,
				turnCount: 5,
				durationS: 120,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: false,
				isSubagent: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("skip");
	});

	test("skips when turns below threshold", () => {
		const result = triageSession(
			{
				sessionId: "s2",
				messageCount: 20,
				turnCount: 2,
				durationS: 120,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: false,
				isSubagent: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("skip");
	});

	test("skips when duration below threshold", () => {
		const result = triageSession(
			{
				sessionId: "s3",
				messageCount: 20,
				turnCount: 5,
				durationS: 10,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: false,
				isSubagent: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("skip");
	});

	test("skips commit-skill sessions (4 msgs, 2 turns, 8s)", () => {
		const result = triageSession(
			{
				sessionId: "commit-skill",
				messageCount: 4,
				turnCount: 2,
				durationS: 8,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: false,
				isSubagent: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("skip");
	});

	test("analyzes session meeting all thresholds", () => {
		const result = triageSession(
			{
				sessionId: "s4",
				messageCount: 20,
				turnCount: 5,
				durationS: 120,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: false,
				isSubagent: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze");
	});

	test("skips sessions with no tool calls when required", () => {
		const result = triageSession(
			{
				sessionId: "s5",
				messageCount: 20,
				turnCount: 5,
				durationS: 120,
				hasToolCalls: false,
				hasSubagents: false,
				hasErrors: false,
				isSubagent: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("skip");
	});

	test("returns analyze_priority for sessions with subagents", () => {
		const result = triageSession(
			{
				sessionId: "s6",
				messageCount: 2,
				turnCount: 1,
				durationS: 5,
				hasToolCalls: false,
				hasSubagents: true,
				hasErrors: false,
				isSubagent: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze_priority");
	});

	test("returns analyze_priority for sessions with errors", () => {
		const result = triageSession(
			{
				sessionId: "s7",
				messageCount: 2,
				turnCount: 1,
				durationS: 5,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: true,
				isSubagent: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze_priority");
	});

	test("returns analyze_priority for long sessions", () => {
		const result = triageSession(
			{
				sessionId: "s8",
				messageCount: 2,
				turnCount: 1,
				durationS: 400,
				hasToolCalls: false,
				hasSubagents: false,
				hasErrors: false,
				isSubagent: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze_priority");
	});

	test("returns analyze_priority for high turn-count sessions", () => {
		const result = triageSession(
			{
				sessionId: "s9",
				messageCount: 30,
				turnCount: 15,
				durationS: 200,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: false,
				isSubagent: false,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze_priority");
	});
});

describe("triageSession — subagent sessions", () => {
	test("uses subagent thresholds (lower turn requirement)", () => {
		const result = triageSession(
			{
				sessionId: "sa1",
				messageCount: 10,
				turnCount: 1,
				durationS: 60,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: false,
				isSubagent: true,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("analyze");
	});

	test("skips small subagents below subagent thresholds", () => {
		const result = triageSession(
			{
				sessionId: "sa2",
				messageCount: 3,
				turnCount: 1,
				durationS: 10,
				hasToolCalls: true,
				hasSubagents: false,
				hasErrors: false,
				isSubagent: true,
			},
			defaultTriageConfig,
		);
		expect(result).toBe("skip");
	});
});
