// Deploy gates (docs/plans/plugins.md, phase 4) against real Postgres: a plugin served by
// Bun.serve rejects a deployment, which fails with its reason in the error and the log, before
// Swarm sees anything; answers are kept per deployment, and the fail mode decides on timeouts.
// Containers are `ls-test-pluggate-*` labelled `logistack.test=pluggate`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PluginManifest } from "@logistack/contracts";
import { encrypt, loadMasterKeys } from "@logistack/core";
import {
	createDb,
	deployment,
	environment,
	instanceSettings,
	organization,
	pluginGateDecision,
	pluginInstall,
	project,
	service,
} from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import type { Ctx } from "../src/ctx.ts";
import { processService } from "../src/deploy.ts";
import { runDeployGates } from "../src/gates.ts";
import { loadService } from "../src/load.ts";
import { cleanup, hasDocker, startInfra, workerConfig } from "./harness.ts";

const AREA = "pluggate";
const ORG = "orgPlugGate";
const INSTALL = "plg_gate0000000000000000000000";

describe.skipIf(!hasDocker)("deploy gates", () => {
	let ctx: Ctx;
	let plugin: ReturnType<typeof Bun.serve>;
	let serviceId: string;
	const asked: { deploymentId: string; service: { name: string } }[] = [];
	let answer: () => Promise<Response> = async () =>
		Response.json({ allow: false, reason: "change freeze until Monday" });

	const newDeployment = async () =>
		(
			await ctx.db
				.insert(deployment)
				.values({ serviceId, status: "queued", trigger: "manual" })
				.returning()
		)[0] as typeof deployment.$inferSelect;

	beforeAll(async () => {
		plugin = Bun.serve({
			port: 0,
			async fetch(req) {
				if (new URL(req.url).pathname !== "/v1/gates/deploy")
					return new Response("no", { status: 404 });
				asked.push((await req.json()) as (typeof asked)[number]);
				return answer();
			},
		});
		const infra = await startInfra(AREA);
		const cfg = await workerConfig(infra, AREA);
		ctx = {
			cfg,
			db: createDb(infra.databaseUrl, { onnotice: () => {} }),
			docker: createDockerClient(),
			bus: { publish: async () => {}, publishLog: async () => {} },
			...(await loadMasterKeys(cfg.LOGISTACK_MASTER_KEY)),
		} as unknown as Ctx;
		await ctx.db
			.insert(organization)
			.values({ id: ORG, name: "Gate", slug: ORG, createdAt: new Date() });
		const [p] = await ctx.db
			.insert(project)
			.values({ organizationId: ORG, name: "Shop", slug: "shop" })
			.returning();
		const [e] = await ctx.db
			.insert(environment)
			.values({
				projectId: p?.id as string,
				name: "Production",
				slug: "production",
				kind: "production",
				isDefault: true,
			})
			.returning();
		const [s] = await ctx.db
			.insert(service)
			.values({
				environmentId: e?.id as string,
				name: "web",
				slug: "web",
				kind: "application",
				spec: {
					kind: "application",
					source: { type: "image", image: "busybox:1.37" },
					build: { type: "image" },
					ports: [],
					replicas: 1,
					resources: { cpu: 0.1, memoryMb: 64 },
					placement: [],
				} as never,
			})
			.returning();
		serviceId = s?.id as string;
		await ctx.db.insert(pluginInstall).values({
			id: INSTALL,
			organizationId: ORG,
			pluginId: "dev.test.freeze",
			version: "1.0.0",
			devUrl: plugin.url.href.replace(/\/$/, ""),
			manifest: PluginManifest.parse({
				id: "dev.test.freeze",
				version: "1.0.0",
				name: "Freeze",
				contributes: { gates: { deploy: true } },
			}),
			configEncrypted: await encrypt(ctx.masterKey, "{}"),
			signingSecretEncrypted: await encrypt(ctx.masterKey, "gate-secret"),
			gateTimeoutSeconds: 1,
		});
		// The dev URL is loopback; the instance allows private hosts as a test instance would.
		await ctx.db.insert(instanceSettings).values({ allowPrivateHosts: true });
	}, 120_000);

	afterAll(async () => {
		plugin?.stop(true);
		await cleanup(AREA);
	}, 120_000);

	test("a rejection fails the deployment with the plugin's reason, in the log too", async () => {
		const d = await newDeployment();
		// The dev URL is loopback; the instance allows private hosts as a test instance would.
		await processService(ctx, serviceId);
		const [row] = await ctx.db
			.select()
			.from(deployment)
			.where(eq(deployment.id, d.id));
		expect(row?.status).toBe("failed");
		expect(row?.error).toBe(
			"rejected by deploy gate Freeze: change freeze until Monday",
		);
		const log = readFileSync(row?.logPath as string, "utf8");
		expect(log).toContain("==> gate Freeze: asking");
		expect(log).toContain(
			"==> failed: rejected by deploy gate Freeze: change freeze until Monday",
		);
		expect(asked.at(-1)).toMatchObject({
			deploymentId: d.id,
			service: { name: "web" },
			environment: { kind: "production" },
			project: { name: "Shop" },
		});
		// Nothing reached Swarm.
		expect(
			(await ctx.docker.services.list({ name: [`ls-test-${AREA}-`] })).length,
		).toBe(0);
	}, 60_000);

	test("an answer is kept: asking again for the same deployment does not call the plugin", async () => {
		const d = await newDeployment();
		const sc = await loadService(ctx, serviceId);
		if (!sc) throw new Error("no service");
		answer = async () => Response.json({ allow: true });
		const lines: string[] = [];
		const before = asked.length;
		const first = await runDeployGates(ctx, sc, d, "img", (l) => lines.push(l));
		answer = async () => Response.json({ allow: false, reason: "changed" });
		const again = await runDeployGates(ctx, sc, d, "img", (l) => lines.push(l));
		expect(first).toEqual({ ok: true });
		expect(again).toEqual({ ok: true });
		expect(asked.length).toBe(before + 1);
		expect(lines).toContain("==> gate Freeze: answered earlier");
		const stored = await ctx.db
			.select()
			.from(pluginGateDecision)
			.where(eq(pluginGateDecision.deploymentId, d.id));
		expect(stored.map((s) => s.allowed)).toEqual([true]);
	});

	test("no answer in time: fail-closed fails, fail-open goes ahead, nothing is stored", async () => {
		answer = async () => {
			await Bun.sleep(2_000);
			return Response.json({ allow: true });
		};
		const sc = await loadService(ctx, serviceId);
		if (!sc) throw new Error("no service");
		const d = await newDeployment();
		const closed = await runDeployGates(ctx, sc, d, "img", () => {});
		expect(closed.ok).toBe(false);
		expect(!closed.ok && closed.error).toMatch(
			/^deploy gate Freeze did not answer .*; it fails closed$/,
		);
		await ctx.db
			.update(pluginInstall)
			.set({ gateFailOpen: true })
			.where(eq(pluginInstall.id, INSTALL));
		const lines: string[] = [];
		expect(
			await runDeployGates(ctx, sc, d, "img", (l) => lines.push(l)),
		).toEqual({ ok: true });
		expect(lines.at(-1)).toContain("fail-open, going ahead");
		expect(
			await ctx.db
				.select()
				.from(pluginGateDecision)
				.where(eq(pluginGateDecision.deploymentId, d.id)),
		).toEqual([]);
	}, 20_000);

	test("a disabled install is not asked", async () => {
		await ctx.db
			.update(pluginInstall)
			.set({ enabled: false })
			.where(eq(pluginInstall.id, INSTALL));
		const sc = await loadService(ctx, serviceId);
		if (!sc) throw new Error("no service");
		const before = asked.length;
		expect(
			await runDeployGates(ctx, sc, await newDeployment(), "img", () => {}),
		).toEqual({ ok: true });
		expect(asked.length).toBe(before);
	});
});
