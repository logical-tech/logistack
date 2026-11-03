import { createDb, runMigrations } from "@logistack/db";

/** Every Docker object this suite creates starts with this; cleanup touches nothing else. */
export const MON_PREFIX = "ls-test-mon-";

export const hasDocker = (() => {
	try {
		return (
			Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" })
				.exitCode === 0
		);
	} catch {
		return false;
	}
})();

export function docker(...args: string[]): string {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args.join(" ")} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

export function removeContainers(names: string[]) {
	for (const name of names)
		if (name.startsWith(MON_PREFIX))
			Bun.spawnSync(["docker", "rm", "-f", "-v", name], {
				stdout: "ignore",
				stderr: "ignore",
			});
}

export function runContainer(
	name: string,
	image: string,
	port: number,
	args: string[] = [],
	cmd: string[] = [],
): string {
	if (!name.startsWith(MON_PREFIX))
		throw new Error(`${name} lacks ${MON_PREFIX}`);
	docker(
		"run",
		"-d",
		"--name",
		name,
		"--label",
		"logistack.test=mon",
		"-p",
		`127.0.0.1::${port}`,
		...args,
		image,
		...cmd,
	);
	return docker("port", name, `${port}/tcp`).split("\n")[0] as string;
}

/** Postgres 17 and Redis 7 named `ls-test-mon-<tag>-*`, migrated and ready. */
export async function startMonInfra() {
	const tag = `${MON_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
	const names = [`${tag}-pg`, `${tag}-redis`];
	try {
		const pg = runContainer(names[0] as string, "postgres:17-alpine", 5432, [
			"-e",
			"POSTGRES_PASSWORD=test",
		]);
		const redis = runContainer(names[1] as string, "redis:7-alpine", 6379);
		const databaseUrl = `postgres://postgres:test@${pg}/postgres`;
		for (let i = 0; ; i++) {
			try {
				await runMigrations(databaseUrl);
				break;
			} catch (e) {
				if (i > 60) throw e;
				await Bun.sleep(500);
			}
		}
		const db = createDb(databaseUrl, { onnotice: () => {} });
		return {
			databaseUrl,
			redisUrl: `redis://${redis}`,
			db,
			sql: db.$client,
			async stop() {
				await db.$client.end();
				removeContainers(names);
			},
		};
	} catch (e) {
		removeContainers(names);
		throw e;
	}
}
