/**
 * A Postgres shaped like Coolify's for the columns the reader takes, and nothing else: install
 * smoke tests use it where running Coolify's own migrations (`coolify-read.test.ts`) is too heavy.
 * Ids are bigints and every other column is text, which is all an empty or projects-only
 * database needs.
 */
import { readColumns } from "../src/migration/coolify/read.ts";

export async function minimalCoolifySchema(url: string) {
	const tables = new Map<string, Set<string>>();
	for (const { table, column } of readColumns()) {
		if (!tables.has(table)) tables.set(table, new Set());
		tables.get(table)?.add(column);
	}
	const sql = new Bun.SQL(url, { max: 1 });
	try {
		for (const [table, columns] of tables)
			await sql.unsafe(
				`create table if not exists "${table}" (${[...columns]
					.map(
						(c) =>
							`"${c}" ${c === "id" || c.endsWith("_id") ? "bigint" : "text"}`,
					)
					.join(", ")})`,
			);
	} finally {
		await sql.close();
	}
}
