/**
 * Test helpers: a throwaway Postgres with Dokploy's schema. `upstream` applies Dokploy's own
 * migrations from a local checkout (`DOKPLOY_SRC`, at `DOKPLOY_REF`), read with `git show` so
 * nothing of Dokploy is copied into this repository.
 */
import { requiredColumns } from "../src/migration/dokploy/read.ts";

export const PG = "ls-test-dokread-pg";

const sh = (...argv: string[]) => {
	const p = Bun.spawnSync(argv, { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
};

export async function startPostgres(): Promise<{
	url: (db: string) => string;
	stop: () => void;
}> {
	const stop = () =>
		Bun.spawnSync(["docker", "rm", "-f", "-v", PG], {
			stdout: "ignore",
			stderr: "ignore",
		});
	stop();
	sh(
		"docker",
		"run",
		"-d",
		"--name",
		PG,
		"--label",
		"logistack.test=dokread",
		"-e",
		"POSTGRES_PASSWORD=test",
		"-p",
		"127.0.0.1::5432",
		"postgres:17-alpine",
	);
	const host = sh("docker", "port", PG, "5432/tcp").split("\n")[0];
	const url = (db: string) => `postgres://postgres:test@${host}/${db}`;
	for (let i = 0; ; i++) {
		const sql = new Bun.SQL(url("postgres"), { max: 1 });
		try {
			await sql`select 1`;
			break;
		} catch (e) {
			if (i > 100) throw e;
			await Bun.sleep(200);
		} finally {
			await sql.close();
		}
	}
	return { url, stop };
}

export async function createDatabase(
	url: (db: string) => string,
	name: string,
): Promise<string> {
	const sql = new Bun.SQL(url("postgres"), { max: 1 });
	await sql.unsafe(`create database "${name}"`);
	await sql.close();
	return url(name);
}

const INT = new Set([
	"replicas",
	"port",
	"externalPort",
	"publishedPort",
	"targetPort",
	"keepLatestCount",
	"smtpPort",
	"githubAppId",
]);
const BOOL = new Set([
	"https",
	"stripPath",
	"permanent",
	"isPreviewDeploymentsActive",
	"autoDeploy",
	"enabled",
	"appDeploy",
	"appBuildError",
	"databaseBackup",
	"volumeBackup",
	"dokployRestart",
	"dokployBackup",
	"dockerCleanup",
	"serverThreshold",
]);
const ARRAY = new Set(["additionalFlags", "toAddress"]);

/** Exactly the columns the reader needs, typed as Dokploy types them. */
export async function minimalSchema(url: string, skip: string[] = []) {
	const tables = new Map<string, string[]>();
	for (const { table, column } of requiredColumns())
		if (!skip.includes(`${table}.${column}`))
			tables.set(table, [...(tables.get(table) ?? []), column]);
	const sql = new Bun.SQL(url, { max: 1 });
	for (const [table, columns] of tables) {
		const defs = [...new Set(columns)].map((c) => {
			const type = INT.has(c)
				? "integer"
				: BOOL.has(c)
					? "boolean"
					: ARRAY.has(c)
						? "text[]"
						: c.endsWith("Swarm")
							? "json"
							: "text";
			return `"${c}" ${type}`;
		});
		await sql.unsafe(`create table "${table}" (${defs.join(", ")})`);
	}
	await sql.close();
}

/** Applies Dokploy's migrations at `ref`, in its journal's order. */
export async function upstreamSchema(url: string, src: string, ref: string) {
	const git = (...args: string[]) => sh("git", "-C", src, ...args);
	const journal = JSON.parse(
		git("show", `${ref}:apps/dokploy/drizzle/meta/_journal.json`),
	) as { entries: { tag: string }[] };
	const sql = new Bun.SQL(url, { max: 1 });
	for (const { tag } of journal.entries)
		for (const statement of git(
			"show",
			`${ref}:apps/dokploy/drizzle/${tag}.sql`,
		).split("--> statement-breakpoint"))
			if (statement.trim()) await sql.unsafe(statement);
	await sql.close();
}
