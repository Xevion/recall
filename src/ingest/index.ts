import type duckdb from "duckdb";
import { loadConfig } from "../config";
import { run, all } from "../db/index";
import { ingestClaudeCode } from "./claude-code";
import { ingestOpenCode } from "./opencode";

export interface IngestOptions {
  source?: "claude-code" | "opencode" | "all";
  since?: string;
  force?: boolean;
}

export interface IngestResult {
  source: string;
  sessionsIngested: number;
  sessionsSkipped: number;
  errors: string[];
}

export async function ingest(db: duckdb.Database, opts: IngestOptions): Promise<IngestResult[]> {
  const config = await loadConfig();
  const results: IngestResult[] = [];
  const sourceFilter = opts.source ?? "all";

  if (
    (sourceFilter === "all" || sourceFilter === "claude-code") &&
    config.sources["claude-code"]?.enabled
  ) {
    const result = await ingestClaudeCode(db, config.sources["claude-code"].path, opts);
    results.push(result);
  }

  if (
    (sourceFilter === "all" || sourceFilter === "opencode") &&
    config.sources["opencode"]?.enabled
  ) {
    const result = await ingestOpenCode(db, config.sources["opencode"].path, opts);
    results.push(result);
  }

  return results;
}
