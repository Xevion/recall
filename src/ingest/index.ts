import type { DuckDBConnection } from "@duckdb/node-api";
import { getLogger } from "@logtape/logtape";
import { loadConfig } from "../config";
import { rebuildFtsIndexes } from "../db/fts";
import { ingestClaudeCode } from "./claude-code";
import { ingestOpenCode } from "./opencode";

const logger = getLogger(["recall", "ingest"]);

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

export async function ingest(
	conn: DuckDBConnection,
	opts: IngestOptions,
): Promise<IngestResult[]> {
	const config = await loadConfig();
	const results: IngestResult[] = [];
	const sourceFilter = opts.source ?? "all";

	if (
		(sourceFilter === "all" || sourceFilter === "claude-code") &&
		config.sources["claude-code"]?.enabled
	) {
		const result = await ingestClaudeCode(
			conn,
			config.sources["claude-code"].path,
			opts,
		);
		results.push(result);
	}

	if (
		(sourceFilter === "all" || sourceFilter === "opencode") &&
		config.sources.opencode?.enabled
	) {
		const result = await ingestOpenCode(
			conn,
			config.sources.opencode.path,
			opts,
		);
		results.push(result);
	}

	const totalIngested = results.reduce((s, r) => s + r.sessionsIngested, 0);
	if (totalIngested > 0) {
		logger.debug("Rebuilding FTS indexes after ingest");
		const start = performance.now();
		await rebuildFtsIndexes(conn);
		const elapsed = Math.round(performance.now() - start);
		logger.debug("FTS indexes rebuilt in {elapsed}ms", { elapsed });
	}

	return results;
}
