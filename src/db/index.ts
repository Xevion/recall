import duckdb from "duckdb";
import { resolve } from "path";
import { loadConfig } from "../config";
import { initSchema } from "./schema";

let _db: duckdb.Database | null = null;

function expandPath(p: string): string {
	if (p.startsWith("~/")) {
		return resolve(process.env.HOME!, p.slice(2));
	}
	return resolve(p);
}

export async function getDb(): Promise<duckdb.Database> {
	if (_db) return _db;

	const config = await loadConfig();
	const dbPath = expandPath(config.database.path);

	// Ensure parent directory exists
	const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
	await Bun.write(Bun.file(dir + "/.keep"), "");

	_db = new duckdb.Database(dbPath);
	await initSchema(_db);
	return _db;
}

export function run(
	db: duckdb.Database,
	sql: string,
	...params: unknown[]
): Promise<void> {
	return new Promise((resolve, reject) => {
		db.run(sql, ...params, (err: Error | null) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

export function all<T = Record<string, unknown>>(
	db: duckdb.Database,
	sql: string,
	...params: unknown[]
): Promise<T[]> {
	return new Promise((resolve, reject) => {
		db.all(sql, ...params, (err: Error | null, rows: T[]) => {
			if (err) reject(err);
			else resolve(rows);
		});
	});
}

export function close(): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!_db) return resolve();
		_db.close((err: Error | null) => {
			_db = null;
			if (err) reject(err);
			else resolve();
		});
	});
}
