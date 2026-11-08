// Real Swarm: the reconciler runs the reference plugin's image as a hardened service, a disabled
// install scales to zero, and a removed row removes the service. Every object is
// `ls-test-plugins-*` labelled `logistack.test=plugins`. Opt in with PLUGINS_IT=1; it builds
// examples/plugins/deploy-notifier first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PluginManifest } from "@logistack/contracts";
import { encrypt, loadMasterKeys, pluginServiceName } from "@logistack/core";
import { createDb, organization, pluginInstall } from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import { manifest } from "../../../examples/plugins/deploy-notifier/src/manifest.ts";
import type { Ctx } from "../src/ctx.ts";
import { reconcilePlugins } from "../src/plugins.ts";
import { hasDocker, sh, startInfra, workerConfig } from "./harness.ts";

const P = "ls-test-plugins-";
const enabled = hasDocker && process.env.PLUGINS_IT === "1";
const IMAGE = `${P}notifier:it`;
const ROOT = `${import.meta.dir}/../../..`;
const INSTALL = "plg_it00000000000000000000000";
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

describe.skipIf(!enabled)("plugin reconciler on Swarm", () => {
	let ctx: Ctx;

	beforeAll(async () => {
		await cleanup();
		sh(
			"docker",
			"build",
			"-q",
			"-f",
			`${ROOT}/examples/plugins/deploy-notifier/Dockerfile`,
			"-t",
			IMAGE,
			ROOT,
		);
		const infra = await startInfra("plugins");
		const cfg = await workerConfig(infra, "plugins");
		const keys = await loadMasterKeys(cfg.LOGISTACK_MASTER_KEY);
		ctx = {
			cfg: { ...cfg, LS_STACK_NAME: `${P}nostack` },
			db: createDb(infra.databaseUrl, { onnotice: () => {} }),
			docker,
			...keys,
		} as unknown as Ctx;
		await ctx.db.insert(organization).values({
			id: "orgPluginsIt",
			name: "It",
			slug: "plugins-it",
			createdAt: new Date(),
		});
		await ctx.db.insert(pluginInstall).values({
			id: INSTALL,
			organizationId: "orgPluginsIt",
			pluginId: manifest.id,
			version: manifest.version,
			image: IMAGE,
			manifest: PluginManifest.parse(manifest),
			configEncrypted: await encrypt(ctx.masterKey, "{}"),
			tokenEncrypted: await encrypt(ctx.masterKey, "lsk_test"),
			signingSecretEncrypted: await encrypt(ctx.masterKey, "it-secret"),
		});
	}, 600_000);

	afterAll(async () => {
		if (!enabled) return;
		await cleanup();
	}, 120_000);

	const name = () => pluginServiceName(INSTALL, P);
	const row = async () =>
		(
			await ctx.db
				.select()
				.from(pluginInstall)
				.where(eq(pluginInstall.id, INSTALL))
		)[0];

	test("runs the image hardened on the plugins network and reports running", async () => {
		for (let i = 0; i < 60; i++) {
			await reconcilePlugins(ctx);
			if ((await row())?.status === "running") break;
			await Bun.sleep(1000);
		}
		expect((await row())?.status).toBe("running");
		const svc = await docker.services.inspect(name());
		const c = svc.Spec.TaskTemplate.ContainerSpec;
		expect(c?.ReadOnly).toBe(true);
		expect(c?.CapabilityDrop).toEqual(["ALL"]);
		expect(c?.Env).toContain(`LOGISTACK_INSTALL_ID=${INSTALL}`);
		expect(svc.Spec.Labels?.["logistack.kind"]).toBe("plugin");
		const net = await docker.networks.inspect(`${P}ls-plugins`);
		expect(svc.Spec.TaskTemplate.Networks?.[0]?.Target).toBe(net.Id);
	}, 120_000);

	test("an unchanged spec is not updated again", async () => {
		const before = (await docker.services.inspect(name())).Version.Index;
		await reconcilePlugins(ctx);
		expect((await docker.services.inspect(name())).Version.Index).toBe(before);
	});

	test("disabling scales to zero", async () => {
		await ctx.db
			.update(pluginInstall)
			.set({ enabled: false })
			.where(eq(pluginInstall.id, INSTALL));
		await reconcilePlugins(ctx);
		const svc = await docker.services.inspect(name());
		expect(svc.Spec.Mode?.Replicated?.Replicas).toBe(0);
		expect((await row())?.status).toBe("disabled");
	});

	test("a deleted install removes its service", async () => {
		await ctx.db.delete(pluginInstall).where(eq(pluginInstall.id, INSTALL));
		await reconcilePlugins(ctx);
		expect(
			(await docker.services.list({ name: [name()] })).filter(
				(s) => s.Spec.Name === name(),
			),
		).toEqual([]);
	});
});
