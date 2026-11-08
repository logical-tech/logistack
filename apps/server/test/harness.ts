import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations } from "@logistack/db";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { closeDeps, createDeps } from "../src/index.ts";
import { setLogLevel } from "../src/log.ts";

function docker(...args: string[]) {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args[0]} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

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

/** Starts `ls-test-<area>-*` Postgres and Redis containers on free ports, labelled `logistack.test=<label>`. */
export async function startInfra(area: string, label: string) {
	const tag = `ls-test-${area}-${crypto.randomUUID().slice(0, 8)}`;
	const names = [`${tag}-pg`, `${tag}-redis`];
	const run = (name: string, image: string, port: number, ...env: string[]) => {
		docker(
			"run",
			"-d",
			"--name",
			name,
			"--label",
			`logistack.test=${label}`,
			"-p",
			`127.0.0.1::${port}`,
			...env.flatMap((e) => ["-e", e]),
			image,
		);
		return docker("port", name, `${port}/tcp`).split("\n")[0] as string;
	};
	const stop = () => {
		for (const name of names)
			Bun.spawnSync(["docker", "rm", "-f", "-v", name], {
				stdout: "ignore",
				stderr: "ignore",
			});
	};
	try {
		const pg = run(
			names[0] as string,
			"postgres:17-alpine",
			5432,
			"POSTGRES_PASSWORD=test",
		);
		const redis = run(names[1] as string, "redis:7-alpine", 6379);
		const databaseUrl = `postgres://postgres:test@${pg}/postgres`;
		const deadline = Date.now() + 30_000;
		for (;;) {
			const db = createDb(databaseUrl, { max: 1, onnotice: () => {} });
			try {
				await db.execute(sql`select 1`);
				break;
			} catch (err) {
				if (Date.now() > deadline) throw err;
				await Bun.sleep(200);
			} finally {
				await db.$client.end();
			}
		}
		return { databaseUrl, redisUrl: `redis://${redis}`, stop };
	} catch (err) {
		stop();
		throw err;
	}
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

/** A stand-in for apps/web/dist: the app shell and one asset. */
export function webDist() {
	const dir = mkdtempSync(join(tmpdir(), "ls-test-server-web-"));
	writeFileSync(join(dir, "index.html"), "<!doctype html><title>shell</title>");
	writeFileSync(join(dir, "app.js"), "console.log(1)");
	return dir;
}

/** `area`/`label` name and label the containers; another suite passes its own so cleanup never overlaps. */
export async function startHarness({
	area = "server",
	label = "true",
	env = {} as Record<string, string>,
} = {}) {
	setLogLevel("silent");
	const infra = await startInfra(area, label);
	try {
		await runMigrations(infra.databaseUrl);
		const config = loadConfig({
			DATABASE_URL: infra.databaseUrl,
			REDIS_URL: infra.redisUrl,
			LOGISTACK_MASTER_KEY: crypto
				.getRandomValues(new Uint8Array(32))
				.toBase64(),
			BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
			BETTER_AUTH_URL: "http://localhost:3000",
			WEB_ORIGIN: "http://localhost:5173",
			PUBLIC_IP: "203.0.113.7",
			LOG_LEVEL: "silent",
			WEB_DIST_DIR: webDist(),
			...env,
		});
		const deps = await createDeps(config);
		const app = createApp(deps);
		const call = async (
			method: string,
			path: string,
			opts: { body?: unknown; headers?: Record<string, string> } = {},
		) => {
			const res = await app.request(path, {
				method,
				headers: {
					origin: config.WEB_ORIGIN,
					...(opts.body === undefined
						? {}
						: { "content-type": "application/json" }),
					...opts.headers,
				},
				body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			});
			const text = await res.text();
			// biome-ignore lint/suspicious/noExplicitAny: tests poke at arbitrary JSON.
			const json: any = res.headers.get("content-type")?.includes("json")
				? JSON.parse(text)
				: text;
			return { status: res.status, json, headers: res.headers };
		};
		/** Signs in and returns a `cookie` header value. */
		const signIn = async (email: string, password: string) => {
			const res = await call("POST", "/api/auth/sign-in/email", {
				body: { email, password },
			});
			if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
			return res.headers
				.getSetCookie()
				.map((c) => c.split(";")[0])
				.join("; ");
		};
		const close = async () => {
			await closeDeps(deps);
			infra.stop();
			rmSync(config.WEB_DIST_DIR, { recursive: true, force: true });
		};
		return { app, deps, config, call, signIn, close };
	} catch (err) {
		infra.stop();
		throw err;
	}
}

export const owner = {
	name: "Olivia Owner",
	email: "owner@example.com",
	password: "correct horse battery",
};

export const setupBody = {
	owner,
	organization: { name: "Acme" },
	instance: {
		publicUrl: "https://ls.example.com",
		generatedDomainBase: "sslip",
		letsencryptEmail: "ops@example.com",
		localRegistryEnabled: true,
	},
};
