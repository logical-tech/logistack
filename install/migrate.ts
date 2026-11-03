// Runs packages/db migrations under a Postgres advisory lock, so api replicas
// starting together apply them once. The lock is released when the session closes.
import { SQL } from "bun";

const MIGRATION_LOCK_KEY = 7_340_001;
const RETRIES = 30;

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("migrate: DATABASE_URL is not set");
	process.exit(1);
}

// max: 1 pins every query to one backend session, which owns the lock.
const sql = new SQL({ url, max: 1 });

for (let attempt = 1; ; attempt++) {
	try {
		await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
		break;
	} catch (error) {
		if (attempt >= RETRIES) throw error;
		console.error(`migrate: waiting for Postgres (${attempt}/${RETRIES})`);
		await Bun.sleep(2000);
	}
}

const proc = Bun.spawn(["bun", "packages/db/src/migrate.ts"], {
	stdio: ["inherit", "inherit", "inherit"],
});
const code = await proc.exited;
await sql.close();
process.exit(code);
