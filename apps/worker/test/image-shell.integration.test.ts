// Real Swarm, Postgres and Redis: an image without /bin/sh (traefik/whoami is FROM scratch) deploys
// healthy with a domain, where the default shell check would fail forever. Opt in with WORKER_IT=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApplicationSpec } from "@logistack/contracts";
import {
	deployment,
	domain,
	environment,
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

const AREA = "shell";
const enabled = hasDocker && process.env.WORKER_IT === "1";

describe.skipIf(!enabled)("images without a shell", () => {
	let w: RunningWorker;
	let orgId: string;
	let serviceId: string;
	const db = () => w.ctx.db;

	const app = (image: string, command?: string[]): ApplicationSpec => ({
		kind: "application",
		source: { type: "image", image },
		build: { type: "image" },
		ports: [],
		replicas: 1,
		resources: {},
		placement: [],
		...(command && { command }),
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
		await waitForDeployment(db(), id);
		const [row] = await db()
			.select()
			.from(deployment)
			.where(eq(deployment.id, id));
		const live = await inspectService(w.ctx, svcName(w.ctx, serviceId));
		return {
			row,
			check: live?.Spec.TaskTemplate.ContainerSpec?.Healthcheck?.Test,
		};
	}

	beforeAll(async () => {
		await cleanup(AREA);
		sh("docker", "pull", "-q", "traefik/whoami:v1.10");
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
				spec: app("traefik/whoami:v1.10"),
			})
			.returning();
		serviceId = s?.id as string;
		// The domain is what turns on the default check.
		await db()
			.insert(domain)
			.values({ serviceId, hostname: "shell.test", port: 80 });
	}, 120_000);

	afterAll(async () => {
		await w?.stop();
		await cleanup(AREA);
	}, 120_000);

	test("a scratch image deploys healthy with no healthcheck", async () => {
		const { row, check } = await deploy(app("traefik/whoami:v1.10"));
		expect(row?.status).toBe("healthy");
		expect(row?.imageShell).toBe(false);
		expect(check).toBeUndefined();
	}, 120_000);

	test("an image with a shell keeps the default check", async () => {
		const { row, check } = await deploy(
			app("busybox:1.37", ["httpd", "-f", "-p", "80", "-h", "/tmp"]),
		);
		expect(row?.status).toBe("healthy");
		expect(row?.imageShell).toBe(true);
		expect(check?.[0]).toBe("CMD-SHELL");
	}, 120_000);

	test("the probe leaves no container behind", () => {
		const left = sh("docker", "ps", "-a", "--format", "{{.Names}}")
			.split("\n")
			.filter((n) => n.startsWith(`ls-test-${AREA}-`) && n.endsWith("-probe"));
		expect(left).toEqual([]);
	});
});
