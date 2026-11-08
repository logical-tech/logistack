// Real Swarm: the plugins overlay is internal, a plugin's only route out is the egress proxy,
// which lets it reach the hosts its manifest declares and nothing else, and an api-like service
// attached to the internal overlay (as the api and worker are) still reaches plugins and the
// internet. Needs internet access (example.com). Every object is `ls-test-plugegress-*`
// labelled `logistack.test=plugegress`; cleanup matches that exact prefix only.
// Opt in with PLUGEGRESS_IT=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManifest } from "@logistack/contracts";
import {
	egressNetworkName,
	egressProxyName,
	encrypt,
	loadMasterKeys,
	pluginServiceName,
	pluginsNetworkName,
} from "@logistack/core";
import { createDb, organization, pluginInstall } from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import type { Ctx } from "../src/ctx.ts";
import { reconcilePlugins } from "../src/plugins.ts";
import { hasDocker, sh, startInfra, workerConfig } from "./harness.ts";

const AREA = "plugegress";
const P = `ls-test-${AREA}-`;
const LABELS = { "logistack.test": AREA };
const enabled = hasDocker && process.env.PLUGEGRESS_IT === "1";
const IMAGE = `${P}img:it`;
const INSTALL = "plg_egress00000000000000000000";
const ROOT = `${import.meta.dir}/../../..`;
const docker = createDockerClient();
const quiet = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" });

async function cleanup() {
	for (const s of await docker.services.list({ name: [P] }))
		if (s.Spec.Name.startsWith(P)) await docker.services.remove(s.ID);
	for (const name of [`${P}pg`, `${P}redis`])
		quiet("docker", "rm", "-f", "-v", name);
	for (let i = 0; i < 60; i++) {
		const nets = (await docker.networks.list({ name: [P] })).filter((n) =>
			n.Name.startsWith(P),
		);
		for (const n of nets) await docker.networks.remove(n.Id).catch(() => {});
		const vols = (await docker.volumes.list({ name: [P] })).filter((v) =>
			v.Name.startsWith(P),
		);
		for (const v of vols) await docker.volumes.remove(v.Name).catch(() => {});
		if (!nets.length && !vols.length) break;
		await Bun.sleep(1000);
	}
}

/** Runs argv in the running task of a Swarm service; never throws. */
async function execIn(service: string, ...argv: string[]) {
	const [c] = await docker.containers.list({
		label: [`com.docker.swarm.service.name=${service}`],
	});
	if (!c) throw new Error(`no running task for ${service}`);
	const p = Bun.spawnSync(["docker", "exec", c.Id, ...argv]);
	return {
		code: p.exitCode,
		out: p.stdout.toString().trim(),
		err: p.stderr.toString().trim(),
	};
}

async function waitRunning(service: string) {
	for (let i = 0; i < 90; i++) {
		const tasks = await docker.tasks.list({
			service: [service],
			"desired-state": ["running"],
		});
		if (tasks.some((t) => t.Status?.State === "running")) return;
		await Bun.sleep(1000);
	}
	throw new Error(`${service} did not start`);
}

describe.skipIf(!enabled)("plugin egress on Swarm", () => {
	let ctx: Ctx;
	const plugin = () => pluginServiceName(INSTALL, P);
	const api = `${P}api`;

	beforeAll(async () => {
		await cleanup();
		// One image plays the plugin, the api and (ROLE=egressproxy) the proxy itself.
		const dir = mkdtempSync(join(tmpdir(), P));
		sh(
			"bun",
			"build",
			`${ROOT}/apps/worker/src/egress-proxy.ts`,
			"--target=bun",
			"--outfile",
			join(dir, "proxy.js"),
		);
		writeFileSync(
			join(dir, "serve.js"),
			'Bun.serve({ port: Number(process.env.PORT || 8080), fetch: () => new Response("ok") });\n',
		);
		writeFileSync(
			join(dir, "Dockerfile"),
			[
				"FROM oven/bun:1.3-alpine",
				"RUN apk add --no-cache curl && mkdir /data && chown bun /data",
				"COPY proxy.js serve.js /app/",
				"USER bun",
				`ENTRYPOINT ["/bin/sh", "-c", "if [ \\"$ROLE\\" = egressproxy ]; then exec bun /app/proxy.js; else exec bun /app/serve.js; fi"]`,
			].join("\n"),
		);
		sh(
			"docker",
			"build",
			"-q",
			"--label",
			`logistack.test=${AREA}`,
			"-t",
			IMAGE,
			dir,
		);
		rmSync(dir, { recursive: true, force: true });

		const infra = await startInfra(AREA);
		const cfg = await workerConfig(infra, AREA);
		ctx = {
			cfg: {
				...cfg,
				LS_STACK_NAME: `${P}nostack`,
				LS_GATEWAY_IMAGE: IMAGE,
				LS_PLUGIN_API_URL: `http://${api}:8080`,
			},
			db: createDb(infra.databaseUrl, { onnotice: () => {} }),
			docker,
			...(await loadMasterKeys(cfg.LOGISTACK_MASTER_KEY)),
		} as unknown as Ctx;
		await ctx.db.insert(organization).values({
			id: "orgEgressIt",
			name: "It",
			slug: "egress-it",
			createdAt: new Date(),
		});
		await ctx.db.insert(pluginInstall).values({
			id: INSTALL,
			organizationId: "orgEgressIt",
			pluginId: "dev.test.egress",
			version: "1.0.0",
			image: IMAGE,
			manifest: PluginManifest.parse({
				id: "dev.test.egress",
				version: "1.0.0",
				name: "Egress",
				egress: ["example.com"],
			}),
			configEncrypted: await encrypt(ctx.masterKey, "{}"),
			tokenEncrypted: await encrypt(ctx.masterKey, "lsk_test"),
			signingSecretEncrypted: await encrypt(ctx.masterKey, "it-secret"),
		});
		for (let i = 0; i < 90; i++) {
			await reconcilePlugins(ctx);
			const [row] = await ctx.db
				.select()
				.from(pluginInstall)
				.where(eq(pluginInstall.id, INSTALL));
			if (row?.status === "running") break;
			await Bun.sleep(1000);
		}
		await waitRunning(plugin());
		await waitRunning(egressProxyName(P));

		// Stand-in for the api: the plugins network plus an ordinary one, as on a stack install.
		const plugins = await docker.networks.inspect(pluginsNetworkName(P));
		await docker.networks.create({
			Name: `${P}apinet`,
			Driver: "overlay",
			Labels: LABELS,
		});
		await docker.services.create({
			Name: api,
			Labels: LABELS,
			TaskTemplate: {
				ContainerSpec: { Image: IMAGE, Labels: LABELS, Env: ["PORT=8080"] },
				Networks: [{ Target: `${P}apinet` }, { Target: plugins.Id }],
			},
			Mode: { Replicated: { Replicas: 1 } },
		});
		await waitRunning(api);
	}, 600_000);

	afterAll(async () => {
		if (!enabled || process.env.KEEP) return;
		await cleanup();
		quiet("docker", "rmi", IMAGE);
	}, 180_000);

	test("the plugins overlay is internal and the egress overlay is not", async () => {
		expect(
			(await docker.networks.inspect(pluginsNetworkName(P))).Internal,
		).toBe(true);
		expect((await docker.networks.inspect(egressNetworkName(P))).Internal).toBe(
			false,
		);
		const env = (await docker.services.inspect(plugin())).Spec.TaskTemplate
			.ContainerSpec?.Env;
		expect(env?.find((e) => e.startsWith("NO_PROXY="))).toBe(
			`NO_PROXY=${api},localhost,127.0.0.1`,
		);
	});

	test("a plugin has no direct route out", async () => {
		const r = await execIn(
			plugin(),
			"curl",
			"-sS",
			"-m",
			"8",
			"--noproxy",
			"*",
			"-o",
			"/dev/null",
			"https://example.com",
		);
		expect(r.code).not.toBe(0);
	}, 30_000);

	test("through the proxy it reaches a declared host", async () => {
		const r = await execIn(
			plugin(),
			"curl",
			"-sS",
			"-m",
			"20",
			"-o",
			"/dev/null",
			"-w",
			"%{http_code}",
			"https://example.com",
		);
		expect(r).toMatchObject({ code: 0, out: "200" });
	}, 30_000);

	test("the proxy refuses an undeclared host", async () => {
		const r = await execIn(
			plugin(),
			"curl",
			"-sS",
			"-m",
			"20",
			"-o",
			"/dev/null",
			"https://example.org",
		);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("403");
	}, 30_000);

	test("the plugin reaches the api directly, past the proxy", async () => {
		const r = await execIn(
			plugin(),
			"sh",
			"-c",
			'curl -sS -m 8 "$LOGISTACK_URL"',
		);
		expect(r).toMatchObject({ code: 0, out: "ok" });
	}, 30_000);

	test("the api, attached to the internal overlay, reaches the plugin and still the internet", async () => {
		const toPlugin = await execIn(
			api,
			"curl",
			"-sS",
			"-m",
			"8",
			`http://${plugin()}:8080/`,
		);
		expect(toPlugin).toMatchObject({ code: 0, out: "ok" });
		const out = await execIn(
			api,
			"curl",
			"-sS",
			"-m",
			"20",
			"-o",
			"/dev/null",
			"-w",
			"%{http_code}",
			"https://example.com",
		);
		expect(out).toMatchObject({ code: 0, out: "200" });
	}, 60_000);
});
