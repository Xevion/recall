import analysisSchema from "../../schemas/analysis-output.json";

export type Outcome = "completed" | "progressed" | "abandoned" | "pivoted";
export type OutcomeConfidence = "high" | "medium" | "low";
export type SessionType =
	| "implementation"
	| "exploration"
	| "debugging"
	| "planning"
	| "review"
	| "maintenance"
	| "research";
export type FrustrationCategory =
	| "tool_failure"
	| "user_correction"
	| "external_blocker"
	| "workflow_antipattern";
export type FrustrationSeverity = "minor" | "significant" | "blocking";

export interface Frustration {
	category: FrustrationCategory;
	description: string;
	severity: FrustrationSeverity;
}

export interface AnalysisOutput {
	title: string;
	summary: string;
	outcome: Outcome;
	outcome_confidence: OutcomeConfidence;
	session_types: SessionType[];
	topics: string[];
	frustrations: Frustration[];
	actionable_insight: string | null;
	is_research_subagent: boolean;
	research_topic: string | null;
	research_tags: string[] | null;
}

export { analysisSchema };
