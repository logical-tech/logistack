// Real Swarm: deploys the `miniflux` template (app + postgres) through the API and a worker,
// to healthy. Opt in with TPL_IT=1; pulls two small images and takes a minute or two.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTerminal } from "@logistack/core";
import { deployment } from "@logistack/db";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../worker/src/config.ts";
import { type RunningWorker, startWorker } from "../../worker/src/index.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const PREFIX = "ls-test-tpl-";
const LABEL = "logistack.test=tpl";
const enabled = hasDocker && process.env.TPL_IT === "1";

function docker(...args: string[]): string {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}
const ours = (kind: string, ...extra: string[]) =>
	docker(kind, "ls", "--filter", `name=${PREFIX}`, ...extra)
		.split("\n")
		.filter((n) => n.startsWith(PREFIX));

/** Removes Swarm objects named `ls-test-tpl-*`; the harness removes its own containers. */
async function cleanup() {
	for (const s of ours("service", "--format", "{{.Name}}"))
		Bun.spawnSync(["docker", "service", "rm", s]);
	for (let i = 0; i < 60; i++) {
		const left = docker(
			"ps",
			"-a",
			"--filter",
			`label=com.docker.swarm.service.name`,
			"--format",
			'{{.Label "com.docker.swarm.service.name"}}',
		)
			.split("\n")
			.filter((n) => n.startsWith(PREFIX));
		if (!left.length) break;
		await Bun.sleep(500);
	}
	for (const c of ours("config", "--format", "{{.Name}}"))
		Bun.spawnSync(["docker", "config", "rm", c]);
	for (const s of ours("secret", "--format", "{{.Name}}"))
		Bun.spawnSync(["docker", "secret", "rm", s]);
	for (const v of ours("volume", "--format", "{{.Name}}"))
		Bun.spawnSync(["docker", "volume", "rm", "-f", v]);
	for (const n of ours("network", "--format", "{{.Name}}"))
		Bun.spawnSync(["docker", "network", "rm", n]);
}

describe.skipIf(!enabled)("template deploy on the real Swarm", () => {
	let h: Harness;
	let w: RunningWorker;
	let work: string;
	let cookie: string;

	beforeAll(async () => {
		await cleanup();
		h = await startHarness({ area: "tpl", label: "tpl" });
		for (const net of ["control", "ingress"])
			docker(
				"network",
				"create",
				"--driver",
				"overlay",
				"--attachable",
				"--label",
				LABEL,
				`${PREFIX}${net}`,
			);
		work = mkdtempSync(join(tmpdir(), PREFIX));
		w = await startWorker(
			loadConfig({
				DATABASE_URL: h.config.DATABASE_URL,
				REDIS_URL: h.config.REDIS_URL,
				LOGISTACK_MASTER_KEY: h.config.LOGISTACK_MASTER_KEY,
				LS_WORK_DIR: work,
				LS_CONTROL_NETWORK: `${PREFIX}control`,
				LS_INGRESS_NETWORK: `${PREFIX}ingress`,
				LS_CADDY_SERVICE: `${PREFIX}caddy`,
				LS_NAME_PREFIX: PREFIX,
				LS_SCOPE_LABELS: JSON.stringify({ "logistack.test": "tpl" }),
				LS_DEPLOY_TIMEOUT_MS: "240000",
				LS_RECONCILE_INTERVAL_MS: "0",
				LOG_LEVEL: "silent",
			}),
		);
		await h.call("POST", "/api/setup", {
			body: {
				...setupBody,
				instance: { ...setupBody.instance, localRegistryEnabled: false },
			},
		});
		cookie = await h.signIn(owner.email, owner.password);
	}, 120_000);

	afterAll(async () => {
		await w?.stop();
		await cleanup();
		await h?.close();
		if (work) rmSync(work, { recursive: true, force: true });
	}, 120_000);

	test("miniflux and its postgres become healthy, and the app reached `db` by its alias", async () => {
		const as = { headers: { cookie } };
		const project = await h.call("POST", "/api/projects", {
			...as,
			body: { name: "Feeds" },
		});
		const envs = await h.call(
			"GET",
			`/api/projects/${project.json.id}/environments`,
			as,
		);
		const res = await h.call(
			"POST",
			`/api/environments/${envs.json[0].id}/templates/miniflux`,
			{
				...as,
				body: { inputs: { adminPassword: "integration-admin-pw" } },
			},
		);
		expect(res.status).toBe(201);
		const services: { id: string; name: string; deploymentId: string }[] =
			res.json.services;
		expect(services.map((s) => s.name)).toEqual(["db", "miniflux"]);

		const deadline = Date.now() + 300_000;
		const final = new Map<string, string>();
		while (final.size < services.length && Date.now() < deadline) {
			for (const s of services) {
				const [d] = await h.deps.db
					.select()
					.from(deployment)
					.where(eq(deployment.id, s.deploymentId));
				if (d && isTerminal(d.status))
					final.set(s.name, d.error ? `${d.status}: ${d.error}` : d.status);
			}
			await Bun.sleep(1000);
		}
		expect(Object.fromEntries(final)).toEqual({
			db: "healthy",
			miniflux: "healthy",
		});

		// The admin row exists only if miniflux reached `db` (its DSN says host=db) and migrated.
		const dbTask = docker(
			"ps",
			"-q",
			"--filter",
			`label=com.docker.swarm.service.name=${PREFIX}ls-svc-${services[0]?.id.slice(4)}`,
		);
		const users = docker(
			"exec",
			dbTask,
			"psql",
			"-U",
			"miniflux",
			"-d",
			"miniflux",
			"-tAc",
			"select username from users",
		);
		expect(users).toBe("admin");
	}, 360_000);
});
