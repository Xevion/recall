/**
 * Seeded topic vocabulary for session analysis.
 * Topics use two-tier "category:tag" format.
 * The LLM picks from this list when possible and mints new tags within a category when nothing fits.
 */
export const TOPIC_VOCABULARY = {
	language: [
		"rust",
		"typescript",
		"python",
		"go",
		"sql",
		"kotlin",
		"java",
		"css",
		"html",
		"shell",
	],
	tool: [
		"stashapp",
		"cloudflare",
		"github-actions",
		"duckdb",
		"ratatui",
		"sveltekit",
		"linear",
		"docker",
		"playwright",
		"vite",
	],
	domain: [
		"deployment",
		"testing",
		"cli-dev",
		"data-pipeline",
		"auth",
		"media-management",
		"session-analytics",
		"api-design",
		"database",
		"config",
	],
	infra: [
		"ci-cd",
		"wrangler",
		"bun",
		"cargo",
		"npm",
		"git",
		"r2-storage",
		"workers",
		"mise",
		"chezmoi",
	],
	activity: [
		"debugging",
		"refactoring",
		"feature-impl",
		"research",
		"cleanup",
		"migration",
		"code-review",
		"documentation",
		"performance",
		"setup",
	],
} as const;

export type TopicCategory = keyof typeof TOPIC_VOCABULARY;

/**
 * Format the vocabulary for inclusion in the analysis prompt.
 */
export function formatTopicVocabulary(): string {
	const lines: string[] = ["Available topic tags (category:tag format):"];
	for (const [category, tags] of Object.entries(TOPIC_VOCABULARY)) {
		lines.push(`  ${category}: ${tags.join(", ")}`);
	}
	lines.push(
		"You may mint new tags within these categories if nothing fits. Format: category:your-tag",
	);
	return lines.join("\n");
}
