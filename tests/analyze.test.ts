import { describe, expect, test } from "bun:test";
import { tryExtractAnalysisOutput } from "../src/analyze/index";

const VALID_OUTPUT = {
	summary: "Brief session fixing a parser bug.",
	topics: ["parser", "bugfix"],
	frustrations: [],
	workflow_notes: "Clean workflow, no issues.",
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
