import type { DuckDBConnection } from "@duckdb/node-api";
import { getLogger } from "@logtape/logtape";
import { all } from "./index";

const logger = getLogger(["recall", "db", "fts"]);

interface FtsIndexConfig {
	table: string;
	idColumn: string;
	columns: string[];
}

const FTS_INDEXES: FtsIndexConfig[] = [
	{ table: "message", idColumn: "id", columns: ["content"] },
	{
		table: "analysis",
		idColumn: "session_id",
		columns: ["title", "summary", "actionable_insight"],
	},
	{
		table: "research_artifact",
		idColumn: "id",
		columns: ["topic", "content"],
	},
];

export async function rebuildFtsIndexes(conn: DuckDBConnection): Promise<void> {
	const start = performance.now();

	for (const idx of FTS_INDEXES) {
		const cols = idx.columns.map((c) => `'${c}'`).join(", ");
		const pragma = `PRAGMA create_fts_index('${idx.table}', '${idx.idColumn}', ${cols}, stemmer='english', stopwords='english', overwrite=1)`;
		logger.debug("Rebuilding index on {table}({columns})", {
			table: idx.table,
			columns: idx.columns.join(", "),
		});
		await conn.run(pragma);
	}

	const elapsed = Math.round(performance.now() - start);
	logger.debug("All indexes rebuilt in {elapsed}ms", { elapsed });
}

export async function ftsIndexesExist(
	conn: DuckDBConnection,
): Promise<boolean> {
	const rows = await all<{ cnt: number }>(
		conn,
		"SELECT COUNT(*)::INT as cnt FROM information_schema.tables WHERE table_schema = 'fts_main_message'",
	);
	return (rows[0]?.cnt ?? 0) > 0;
}
