import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { loadConfig } from "../config";
import { expandPath } from "../utils/path";
import { initSchema } from "./schema";

let _instance: DuckDBInstance | null = null;
let _conn: DuckDBConnection | null = null;

export async function getConnection(): Promise<DuckDBConnection> {
	if (_conn) return _conn;

	const config = await loadConfig();
	const dbPath = expandPath(config.database.path);

	// Ensure parent directory exists
	const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
	await Bun.write(Bun.file(`${dir}/.keep`), "");

	_instance = await DuckDBInstance.create(dbPath);
	_conn = await _instance.connect();
	await initSchema(_conn);
	return _conn;
}

/** Alias kept for callers that use `getDb()`. */
export const getDb = getConnection;

export async function run(
	conn: DuckDBConnection,
	sql: string,
	...params: unknown[]
): Promise<void> {
	if (params.length > 0) {
		await conn.run(sql, params as Parameters<typeof conn.run>[1]);
	} else {
		await conn.run(sql);
	}
}

export async function all<T = Record<string, unknown>>(
	conn: DuckDBConnection,
	sql: string,
	...params: unknown[]
): Promise<T[]> {
	const reader =
		params.length > 0
			? await conn.runAndReadAll(
					sql,
					params as Parameters<typeof conn.runAndReadAll>[1],
				)
			: await conn.runAndReadAll(sql);
	return reader.getRowObjectsJson() as unknown as T[];
}

export async function withTransaction<T>(
	conn: DuckDBConnection,
	fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
	await conn.run("BEGIN");
	try {
		const result = await fn(conn);
		await conn.run("COMMIT");
		return result;
	} catch (err) {
		await conn.run("ROLLBACK");
		throw err;
	}
}

export async function close(): Promise<void> {
	if (_conn) {
		_conn.closeSync();
		_conn = null;
	}
	_instance = null;
}
