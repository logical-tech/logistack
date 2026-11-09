import { fileURLToPath } from "node:url";
import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Any value works; it only has to be the same for every LogiStack process. */
const MIGRATION_LOCK = 7_461_009_331;

export type AppliedMigration = { hash: string; created_at: string | number };

/**
 * Migrations not yet recorded, in journal order. A migration counts as applied when its hash
 * OR its journal timestamp is recorded: the hash covers renumbered files, the timestamp covers
 * a file whose SQL was edited after it ran somewhere.
 *
 * Drizzle's own migrator only applies migrations newer than the last recorded timestamp, so a
 * journal whose timestamps are not increasing (0051–0058 carry far-future ones) silently skips
 * every later migration on databases that already ran them. This selection does not depend on
 * order.
 */
export function pendingMigrations(
	journal: readonly MigrationMeta[],
	applied: readonly AppliedMigration[],
): MigrationMeta[] {
	const hashes = new Set(applied.map((a) => a.hash));
	const times = new Set(applied.map((a) => Number(a.created_at)));
	return journal.filter(
		(m) => !hashes.has(m.hash) && !times.has(m.folderMillis),
	);
}

/** Applies pending migrations from packages/db/drizzle. Safe to rerun and to run concurrently. */
export async function runMigrations(
	url: string,
	/** Tests pass a slice of the journal to reproduce a partly migrated database. */
	journal: readonly MigrationMeta[] = readMigrationFiles({ migrationsFolder }),
): Promise<void> {
	const client = postgres(url, { max: 1, onnotice: () => {} });
	try {
		await client.begin(async (tx) => {
			// Several api replicas boot at once; the loser waits, then finds nothing pending.
			await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
			// Same table as drizzle-kit and drizzle's migrator, so existing databases keep their history.
			await tx`create schema if not exists drizzle`;
			await tx`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
			const applied = await tx<AppliedMigration[]>`
				select hash, created_at from drizzle.__drizzle_migrations`;
			for (const m of pendingMigrations(journal, applied)) {
				for (const statement of m.sql) {
					if (statement.trim()) await tx.unsafe(statement);
				}
				await tx`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
			}
		});
	} finally {
		await client.end();
	}
}

if (import.meta.main) {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is not set");
	await runMigrations(url);
	console.log("migrations applied");
}
