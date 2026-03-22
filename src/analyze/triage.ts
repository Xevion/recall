import type { RecallConfig } from "../config";

export interface TriageInput {
	sessionId: string;
	messageCount: number;
	turnCount: number;
	durationS: number;
	hasToolCalls: boolean;
	hasSubagents: boolean;
	hasErrors: boolean;
	isSubagent: boolean;
}

export type TriageDecision = "skip" | "analyze" | "analyze_priority";

export function triageSession(
	input: TriageInput,
	config: RecallConfig["analyze"]["triage"],
): TriageDecision {
	const thresholds = input.isSubagent
		? config.subagent_thresholds
		: config.parent_thresholds;

	// Auto-analyze if any priority signal fires
	if (!input.isSubagent) {
		if (input.hasSubagents && config.auto_analyze_if_subagents)
			return "analyze_priority";
		if (input.hasErrors && config.auto_analyze_if_errors)
			return "analyze_priority";
	}
	if (input.turnCount > config.auto_analyze_min_turns)
		return "analyze_priority";
	if (input.durationS > config.auto_analyze_min_duration_s)
		return "analyze_priority";

	// OR-based skip: skip if ANY threshold is below minimum
	if (input.messageCount < thresholds.min_messages) return "skip";
	if (input.turnCount < thresholds.min_turns) return "skip";
	if (input.durationS < thresholds.min_duration_s) return "skip";

	if (thresholds.require_tool_calls && !input.hasToolCalls) {
		return "skip";
	}

	return "analyze";
}
