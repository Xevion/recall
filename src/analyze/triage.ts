import type { RecallConfig } from "../config";

export interface TriageInput {
	sessionId: string;
	messageCount: number;
	turnCount: number;
	durationS: number;
	hasToolCalls: boolean;
	hasSubagents: boolean;
	hasErrors: boolean;
}

export type TriageDecision = "skip" | "analyze" | "analyze_priority";

export function triageSession(
	input: TriageInput,
	config: RecallConfig["analyze"]["triage"],
): TriageDecision {
	// Auto-analyze if any priority signal fires
	if (input.hasSubagents && config.auto_analyze_if_subagents)
		return "analyze_priority";
	if (input.turnCount > config.auto_analyze_min_turns)
		return "analyze_priority";
	if (input.hasErrors && config.auto_analyze_if_errors)
		return "analyze_priority";
	if (input.durationS > config.auto_analyze_min_duration_s)
		return "analyze_priority";

	// Skip if below all thresholds
	if (
		input.messageCount < config.min_messages &&
		input.turnCount < config.min_turns &&
		input.durationS < config.min_duration_s
	) {
		return "skip";
	}

	if (config.require_tool_calls && !input.hasToolCalls) {
		return "skip";
	}

	return "analyze";
}
