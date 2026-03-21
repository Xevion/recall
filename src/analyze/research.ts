import type duckdb from "duckdb";
import { run, all } from "../db/index";
import type { AnalysisOutput } from "./schema";
import type { RecallConfig } from "../config";

/**
 * Check if a subagent session looks like research work,
 * using both prompt keyword matching and LLM classification.
 */
export function isResearchByPrompt(prompt: string | null, signals: string[]): boolean {
  if (!prompt) return false;
  const lower = prompt.toLowerCase();
  return signals.some((signal) => {
    // Support regex patterns in signals
    if (signal.includes(".*") || signal.includes("[") || signal.includes("(")) {
      try {
        return new RegExp(signal, "i").test(lower);
      } catch {
        return lower.includes(signal.toLowerCase());
      }
    }
    return lower.includes(signal.toLowerCase());
  });
}

/**
 * Extract and persist a research artifact from a subagent session.
 */
export async function extractResearchArtifact(
  db: duckdb.Database,
  sessionId: string,
  parentSessionId: string | null,
  analysis: AnalysisOutput,
): Promise<void> {
  // Get the subagent's result content
  const [subagent] = await all<{ result: string | null }>(
    db,
    "SELECT result FROM subagent WHERE session_id = ?",
    sessionId,
  );

  if (!subagent?.result) return;

  const artifactId = `ra-${sessionId}`;

  await run(
    db,
    `INSERT OR REPLACE INTO research_artifact
     (id, session_id, parent_session_id, topic, content, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, now())`,
    artifactId,
    sessionId,
    parentSessionId,
    analysis.research_topic ?? analysis.summary.slice(0, 100),
    subagent.result,
    JSON.stringify(analysis.research_tags ?? analysis.topics),
  );
}
