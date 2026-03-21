import analysisSchema from "../../schemas/analysis-output.json";

export interface AnalysisOutput {
  summary: string;
  topics: string[];
  frustrations: string[];
  workflow_notes: string;
  is_research_subagent: boolean;
  research_topic: string | null;
  research_tags: string[] | null;
}

export { analysisSchema };
