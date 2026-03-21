import { describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { all, withTransaction } from "../src/db/index";
import { initSchema } from "../src/db/schema";

describe("initSchema", () => {
	test("calling initSchema twice on same connection succeeds", async () => {
		const instance = await DuckDBInstance.create(":memory:");
		const conn = await instance.connect();
		await initSchema(conn);
		// Second call should not throw
		await initSchema(conn);
		conn.closeSync();
	});

	test("ENUMs present after init", async () => {
		const instance = await DuckDBInstance.create(":memory:");
		const conn = await instance.connect();
		await initSchema(conn);

		const rows = await all<{ type_name: string }>(
			conn,
			"SELECT type_name FROM duckdb_types() WHERE type_name IN ('source_type', 'analysis_status') ORDER BY type_name",
		);
		const names = rows.map((r) => r.type_name);
		expect(names).toContain("analysis_status");
		expect(names).toContain("source_type");
		conn.closeSync();
	});

	test("withTransaction rolls back on error", async () => {
		const instance = await DuckDBInstance.create(":memory:");
		const conn = await instance.connect();
		await initSchema(conn);

		// Insert a session inside a transaction that throws
		try {
			await withTransaction(conn, async (c) => {
				await c.run(
					`INSERT INTO session (id, source, started_at) VALUES ('rollback-test', 'claude-code', '2026-01-01T00:00:00Z')`,
				);
				throw new Error("force rollback");
			});
		} catch {}

		const rows = await all(
			conn,
			"SELECT id FROM session WHERE id = 'rollback-test'",
		);
		expect(rows).toHaveLength(0);
		conn.closeSync();
	});
});
