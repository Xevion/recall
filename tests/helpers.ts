import { DuckDBInstance } from "@duckdb/node-api";
import { initSchema } from "../src/db/schema";

export async function createTestDb() {
	const instance = await DuckDBInstance.create(":memory:");
	const conn = await instance.connect();
	await initSchema(conn);
	return { instance, conn };
}
