import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The slice of the D1 API the Worker uses, over an in-memory SQLite with the real migrations.
 * Shortcut: no D1 network semantics; `wrangler dev` covers the real binding.
 */
export function fakeD1() {
	const db = new Database(":memory:");
	const dir = join(import.meta.dir, "../migrations");
	for (const f of readdirSync(dir).sort())
		db.exec(readFileSync(join(dir, f), "utf8"));
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		first: async () =>
			(db.query(sql).get(...(args as never[])) as unknown) ?? null,
		all: async () => ({ results: db.query(sql).all(...(args as never[])) }),
		run: async () => {
			const r = db.query(sql).run(...(args as never[]));
			return { meta: { changes: r.changes } };
		},
	});
	const d1 = {
		prepare: (sql: string) => stmt(sql),
		// One transaction, like D1's batch.
		batch: async (stmts: ReturnType<typeof stmt>[]) => {
			const out: { meta: { changes: number } }[] = [];
			db.exec("BEGIN");
			try {
				for (const s of stmts) out.push(await s.run());
				db.exec("COMMIT");
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
			return out;
		},
	};
	return { d1: d1 as unknown as D1Database, db };
}
