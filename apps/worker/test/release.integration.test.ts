// Real Swarm, Postgres and Redis. Opt in with WORKER_IT=1; a few minutes (30 s rollout monitor).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ApplicationSpec } from "@logistack/contracts";
import { encrypt } from "@logistack/core";
import {
	deployment,
	environment,
	envVar,
	organization,
	project,
	service,
} from "@logistack/db";
import { eq } from "drizzle-orm";
import { inspectService } from "../src/apply.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";
import { svcName } from "../src/load.ts";
import {
	cleanup,
	hasDocker,
	sh,
	startInfra,
	waitForDeployment,
	workerConfig,
} from "./harness.ts";

const AREA = "release";
const enabled = hasDocker && process.env.WORKER_IT === "1";

describe.skipIf(!enabled)("release phase against the real Swarm", () => {
	let w: RunningWorker;
	let orgId: string;
	let serviceId: string;
	const db = () => w.ctx.db;

	const app = (o: Partial<ApplicationSpec> = {}): ApplicationSpec => ({
		kind: "application",
		source: { type: "image", image: "busybox:1.37" },
		build: { type: "image" },
		ports: [],
		replicas: 1,
		resources: {},
		command: ["sh", "-c", "exec httpd -f -p 8080 -h /tmp"],
		placement: [],
		...o,
	});

	async function deploy(spec: ApplicationSpec) {
		await db().update(service).set({ spec }).where(eq(service.id, serviceId));
		const [d] = await db()
			.insert(deployment)
			.values({ serviceId, trigger: "api" })
			.returning();
		const id = d?.id as string;
		await w.ctx.bus.publish(
			"deployment.queued",
			orgId,
			{ type: "deployment", id },
			{ serviceId },
		);
		const done = (await waitForDeployment(db(), id)) as Awaited<
			ReturnType<typeof waitForDeployment>
		> & { seen: string[] };
		const log = await readFile(done.logPath as string, "utf8");
		return { ...done, log };
	}

	const liveDeployment = async () =>
		(await inspectService(w.ctx, svcName(w.ctx, serviceId)))?.Spec.Labels?.[
			"logistack.deployment"
		];

	const releaseJobs = () =>
		sh("docker", "service", "ls", "--format", "{{.Name}}")
			.split("\n")
			.filter(
				(n) => n.startsWith(`ls-test-${AREA}-`) && /-(pre|post)$/.test(n),
			);

	beforeAll(async () => {
		await cleanup(AREA);
		sh("docker", "pull", "-q", "busybox:1.37");
		w = await startWorker(await workerConfig(await startInfra(AREA), AREA));
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
		const [s] = await db()
			.insert(service)
			.values({
				environmentId: e?.id as string,
				name: "web",
				slug: "web",
				kind: "application",
				spec: app(),
			})
			.returning();
		serviceId = s?.id as string;
		await db()
			.insert(envVar)
			.values({
				scope: "service",
				scopeId: serviceId,
				key: "VERSION",
				valueEncrypted: await encrypt(w.ctx.masterKey, "2"),
			});
	}, 120_000);

	afterAll(async () => {
		await w?.stop();
		await cleanup(AREA);
	}, 120_000);

	let first: string;

	test("baseline deploy without release commands", async () => {
		const d = await deploy(app());
		expect(d.status).toBe("healthy");
		first = d.id;
	}, 120_000);

	test("a failing pre-deploy blocks the rollout and leaves the old version running", async () => {
		const d = await deploy(
			app({
				preDeploy: {
					command: ["sh", "-c", "echo migrating; exit 3"],
					timeoutSeconds: 60,
				},
			}),
		);
		expect(d.status).toBe("failed");
		expect(d.seen).toContain("releasing");
		expect(d.seen).not.toContain("deploying");
		expect(d.error).toBe("pre-deploy exited with 3");
		expect(d.log).toContain("migrating");
		expect(await liveDeployment()).toBe(first);
		expect(releaseJobs()).toEqual([]);
	}, 120_000);

	test("a pre-deploy that succeeds runs with the service env before the update; a failing post-deploy only warns", async () => {
		const d = await deploy(
			app({
				preDeploy: {
					command: ["sh", "-c", 'echo "pre v=$VERSION"'],
					timeoutSeconds: 60,
				},
				postDeploy: { command: ["false"], timeoutSeconds: 60 },
			}),
		);
		expect(d.status).toBe("healthy");
		expect(d.seen).toEqual(
			expect.arrayContaining(["releasing", "deploying", "healthy"]),
		);
		expect(d.warning).toBe("post-deploy exited with 1");
		const pre = d.log.indexOf("pre v=2");
		expect(pre).toBeGreaterThan(-1);
		expect(pre).toBeLessThan(d.log.indexOf("==> deploying"));
		expect(d.log.indexOf("==> post-deploy")).toBeGreaterThan(
			d.log.indexOf("==> deploying"),
		);
		expect(await liveDeployment()).toBe(d.id);
		expect(releaseJobs()).toEqual([]);
	}, 180_000);
});
