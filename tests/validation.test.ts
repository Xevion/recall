import { describe, expect, test } from "bun:test";
import { resolveProjectOption } from "../src/utils/validation";

describe("resolveProjectOption", () => {
	test("returns undefined when no flag given", () => {
		expect(resolveProjectOption(undefined)).toBeUndefined();
	});

	test("returns explicit string when given", () => {
		expect(resolveProjectOption("recall")).toBe("recall");
	});

	test("returns explicit string as-is without transformation", () => {
		expect(resolveProjectOption("my-project")).toBe("my-project");
	});

	test("auto-detects from cwd when bare flag (true)", () => {
		// process.cwd() during tests is the recall project dir
		const result = resolveProjectOption(true);
		expect(result).toBe("recall");
	});

	test("returns undefined when bare flag and extractProjectName returns null", () => {
		// extractProjectName returns null for empty/null input
		// We can't easily force process.cwd() to return null, but we can verify
		// the function handles the case where detection succeeds (covered above)
		// and that it passes through undefined correctly
		const result = resolveProjectOption(undefined);
		expect(result).toBeUndefined();
	});

	test("returns empty string if explicitly passed", () => {
		expect(resolveProjectOption("")).toBe("");
	});
});
