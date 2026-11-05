// Real Swarm, Postgres and Redis. Opt in with WORKER_IT=1; takes a few minutes (30 s rollout monitor).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApplicationSpec } from "@logistack/contracts";
import { encrypt } from "@logistack/core";
import {
	deployment,
	domain,
	environment,
	envVar,
	organization,
	project,
	service,
	serviceStatus,
} from "@logistack/db";
import { eq } from "drizzle-orm";
import { inspectService } from "../src/apply.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";
import { svcName } from "../src/load.ts";
import { reconcilePass, sweepOrphans } from "../src/reconcile.ts";
import {
	BUILDKIT_CLIENT,
	cleanup,
	fixtureRepo,
	hasDocker,
	PREFIX,
	sh,
	startInfra,
	waitForDeployment,
	workerConfig,
} from "./harness.ts";

const enabled = hasDocker && process.env.WORKER_IT === "1";

describe.skipIf(!enabled)("worker against the real Swarm", () => {
	let w: RunningWorker;
	let orgId: string;
	let envId: string;
	const port = 20000 + Math.floor(Math.random() * 20000);

	const ctx = () => w.ctx;
	const db = () => w.ctx.db;

	async function queue(serviceId: string) {
		const [d] = await db()
			.insert(deployment)
			.values({ serviceId, trigger: "api" })
			.returning();
		const id = d?.id as string;
		// Exactly what the API does: insert, then publish on ls:events.
		await ctx().bus.publish(
			"deployment.queued",
			orgId,
			{ type: "deployment", id },
			{ serviceId },
		);
		return id;
	}

	async function setEnv(serviceId: string, key: string, value: string) {
		const valueEncrypted = await encrypt(ctx().masterKey, value);
		await db()
			.insert(envVar)
			.values({ scope: "service", scopeId: serviceId, key, valueEncrypted })
			.onConflictDoUpdate({
				target: [envVar.scope, envVar.scopeId, envVar.key],
				set: { valueEncrypted },
			});
	}

	async function addService(name: string, spec: ApplicationSpec) {
		const [row] = await db()
			.insert(service)
			.values({
				environmentId: envId,
				name,
				slug: name,
				kind: "application",
				spec,
			})
			.returning();
		return row?.id as string;
	}

	beforeAll(async () => {
		await cleanup();
		sh("docker", "pull", "-q", "busybox:1.37");
		sh("docker", "pull", "-q", BUILDKIT_CLIENT);
		w = await startWorker(await workerConfig(await startInfra()));
		orgId = `org_${crypto.randomUUID().slice(0, 8)}`;
		await db()
			.insert(organization)
			.values({ id: orgId, name: "Test", slug: orgId, createdAt: new Date() });
		const [p] = await db()
			.insert(project)
			.values({ organizationId: orgId, name: "P", slug: "p" })
			.returning();
		const [e] = await db()
			.insert(environment)
			.values({
				projectId: p?.id as string,
				name: "Prod",
				slug: "prod",
				kind: "production",
				isDefault: true,
			})
			.returning();
		envId = e?.id as string;
	}, 120_000);

	afterAll(async () => {
		await w?.stop();
		await cleanup();
	}, 120_000);

	let webId: string;
	let firstDeployment: string;
	let secondDeployment: string;

	const web: ApplicationSpec = {
		kind: "application",
		source: { type: "image", image: "busybox:1.37" },
		build: { type: "image" },
		ports: [{ target: 8080, published: port, protocol: "tcp" }],
		replicas: 1,
		resources: {},
		command: [
			"sh",
			"-c",
			'echo "v=$VERSION" > /tmp/index.html && exec httpd -f -p 8080 -h /tmp',
		],
		placement: [],
	};

	test("image source deploys end to end: queued -> deploying -> healthy", async () => {
		webId = await addService("web", web);
		await db()
			.insert(domain)
			.values({ serviceId: webId, hostname: "web.test", port: 8080 });
		await setEnv(webId, "VERSION", "1");
		firstDeployment = await queue(webId);
		const d = await waitForDeployment(db(), firstDeployment);
		expect(d.status).toBe("healthy");
		expect((d as unknown as { seen: string[] }).seen.at(-1)).toBe("healthy");
		expect(d.imageRef).toBe("busybox:1.37");
		expect(d.logPath).toBeTruthy();

		const svc = await inspectService(ctx(), svcName(ctx(), webId));
		expect(svc?.Spec.Labels).toMatchObject({
			"logistack.managed": "true",
			"logistack.resource": webId,
			"logistack.test": "worker",
			"logistack.deployment": firstDeployment,
		});
		const nets = svc?.Spec.TaskTemplate.Networks?.length;
		expect(nets).toBe(2); // env + ingress, because it has a domain
		expect(svc?.Spec.TaskTemplate.ContainerSpec.Healthcheck?.Test[0]).toBe(
			"CMD-SHELL",
		);
		const res = await fetch(`http://127.0.0.1:${port}/`);
		expect(await res.text()).toBe("v=1\n");
		const env = svc?.Spec.TaskTemplate.ContainerSpec.Env ?? [];
		expect(env).toEqual(
			expect.arrayContaining([
				`LOGISTACK_DEPLOYMENT_ID=${firstDeployment}`,
				"LOGISTACK_PROJECT=P",
				"LOGISTACK_ENVIRONMENT=Prod",
				"LOGISTACK_SERVICE=web",
				"LOGISTACK_URL=https://web.test",
				"LOGISTACK_FQDN=web.test",
			]),
		);
		expect(env.filter((e) => /^LOGISTACK_(COMMIT|BRANCH)/.test(e))).toEqual([]);
	}, 120_000);

	test("redeploy with new env rolls start-first with zero failed requests", async () => {
		await setEnv(webId, "VERSION", "2");
		let ok = 0;
		let failed = 0;
		let sawV2 = false;
		let loop = true;
		const load = (async () => {
			while (loop) {
				try {
					const r = await fetch(`http://127.0.0.1:${port}/`, {
						headers: { connection: "close" },
						signal: AbortSignal.timeout(2_000),
					});
					const body = await r.text();
					if (r.ok) ok++;
					else failed++;
					if (body === "v=2\n") sawV2 = true;
				} catch {
					failed++;
				}
				await Bun.sleep(20);
			}
		})();
		secondDeployment = await queue(webId);
		const d = await waitForDeployment(db(), secondDeployment);
		loop = false;
		await load;
		console.log(`redeploy load: ${ok} ok, ${failed} failed`);
		expect(d.status).toBe("healthy");
		expect(sawV2).toBe(true);
		expect(ok).toBeGreaterThan(100);
		expect(failed).toBe(0);
	}, 180_000);

	test("a failing healthcheck ends failed with the rollback recorded", async () => {
		await db()
			.update(service)
			.set({
				spec: { ...web, healthcheck: { type: "command", command: ["false"] } },
			})
			.where(eq(service.id, webId));
		const id = await queue(webId);
		const d = await waitForDeployment(db(), id);
		expect(d.status).toBe("failed");
		expect(d.error).toMatch(/^rolled back/);
		const svc = await inspectService(ctx(), svcName(ctx(), webId));
		expect(svc?.Spec.Labels?.["logistack.deployment"]).toBe(secondDeployment);
		await db().update(service).set({ spec: web }).where(eq(service.id, webId));
	}, 180_000);

	test("reconciler recreates a manually removed service and records its status", async () => {
		const name = svcName(ctx(), webId);
		const before = await inspectService(ctx(), name);
		await ctx().docker.services.remove(before?.ID as string);
		// The remove event also queues a pass; whichever holds the lock recreates it.
		let after = await inspectService(ctx(), name);
		for (let i = 0; i < 30 && (!after || after.ID === before?.ID); i++) {
			await reconcilePass(ctx());
			await Bun.sleep(500);
			after = await inspectService(ctx(), name);
		}
		expect(after?.ID).toBeDefined();
		expect(after?.ID).not.toBe(before?.ID);
		expect(after?.Spec.Labels?.["logistack.deployment"]).toBe(secondDeployment);
		for (let i = 0; i < 60; i++) {
			await reconcilePass(ctx());
			const [s] = await db()
				.select()
				.from(serviceStatus)
				.where(eq(serviceStatus.serviceId, webId));
			if (s?.observed === "running") break;
			await Bun.sleep(1_000);
		}
		const [s] = await db()
			.select()
			.from(serviceStatus)
			.where(eq(serviceStatus.serviceId, webId));
		expect(s).toMatchObject({
			observed: "running",
			replicasRunning: 1,
			replicasDesired: 1,
		});
	}, 120_000);

	test("dockerfile build from a git repo through BuildKit to healthy", async () => {
		const repo = await fixtureRepo();
		const appId = await addService("built", {
			kind: "application",
			source: {
				type: "git",
				repository: `file://${repo}`,
				branch: "main",
				path: ".",
			},
			build: { type: "dockerfile", dockerfilePath: "Dockerfile", context: "." },
			ports: [],
			replicas: 1,
			resources: {},
			healthcheck: { type: "tcp", port: 8080 },
			placement: [],
		});
		const id = await queue(appId);
		const d = await waitForDeployment(db(), id, 300_000);
		expect(d.error).toBeNull();
		expect(d.status).toBe("healthy");
		expect((d as unknown as { seen: string[] }).seen).toContain("deploying");
		expect(d.commitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(d.commitMessage).toBe("fixture app");
		expect(d.imageRef).toBe(
			`ls-local/${orgId.toLowerCase()}/${svcName(ctx(), appId)}:${id}`,
		);
		const log = await Bun.file(d.logPath as string).text();
		expect(log).toContain("==> building");
		expect(log).toContain("==> healthy");
		const env =
			(await inspectService(ctx(), svcName(ctx(), appId)))?.Spec.TaskTemplate
				.ContainerSpec.Env ?? [];
		expect(env).toEqual(
			expect.arrayContaining([
				`LOGISTACK_COMMIT_SHA=${d.commitSha}`,
				"LOGISTACK_COMMIT_MESSAGE=fixture app",
				"LOGISTACK_BRANCH=main",
			]),
		);
		// The Dockerfile declares this ARG, so the build saw the cloned commit.
		expect(
			sh(
				"docker",
				"run",
				"--rm",
				"--name",
				`${PREFIX}commit`,
				"--label",
				"logistack.test=worker",
				d.imageRef as string,
				"cat",
				"/www/commit",
			),
		).toBe(d.commitSha as string);
	}, 320_000);

	test("orphaned objects are removed only after the grace period", async () => {
		const name = svcName(ctx(), webId);
		await db().delete(service).where(eq(service.id, webId));
		const now = Date.now();
		expect(await sweepOrphans(ctx(), now)).toEqual([]);
		expect(await inspectService(ctx(), name)).toBeDefined();
		const removed = await sweepOrphans(
			ctx(),
			now + ctx().cfg.LS_ORPHAN_GRACE_MS + 1,
		);
		expect(removed).toContain(`service:${name}`);
		expect(await inspectService(ctx(), name)).toBeUndefined();
		expect(removed.every((k) => k.split(":")[1]?.startsWith(PREFIX))).toBe(
			true,
		);
	}, 60_000);
});
