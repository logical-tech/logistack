// Real Swarm, Postgres and Redis. Opt in with WORKER_IT=1; about a minute.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApplicationSpec } from "@logistack/contracts";
import { dockerName } from "@logistack/core";
import {
	deployment,
	environment,
	mount,
	organization,
	project,
	service,
} from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import { type RunningWorker, startWorker } from "../src/index.ts";
import { expirePreviews } from "../src/previews.ts";
import { sweepOrphans } from "../src/reconcile.ts";
import {
	cleanup,
	hasDocker,
	sh,
	startInfra,
	waitForDeployment,
	workerConfig,
} from "./harness.ts";

const AREA = "preview";
const PREFIX = `ls-test-${AREA}-`;
const enabled = hasDocker && process.env.WORKER_IT === "1";
const docker = createDockerClient();

describe.skipIf(!enabled)("preview cleanup against the real Swarm", () => {
	let w: RunningWorker;
	let orgId: string;
	let projectId: string;
	const db = () => w.ctx.db;
	const spec: ApplicationSpec = {
		kind: "application",
		source: { type: "image", image: "busybox:1.37" },
		build: { type: "image" },
		ports: [],
		replicas: 1,
		resources: {},
		command: ["sh", "-c", "exec httpd -f -p 8080 -h /tmp"],
		placement: [],
	};

	/** An environment with one busybox service mounting a volume at /data, deployed until healthy. */
	async function deployed(slug: string, preview: boolean) {
		const [e] = await db()
			.insert(environment)
			.values({
				projectId,
				name: slug,
				slug,
				kind: preview ? "preview" : "production",
				...(preview && {
					preview: {
						number: 1,
						title: "t",
						headBranch: "f",
						headSha: "a".repeat(40),
						author: "dev",
						urls: [],
						expiresAt: new Date(Date.now() - 60_000).toISOString(),
					},
				}),
			})
			.returning();
		const [s] = await db()
			.insert(service)
			.values({
				environmentId: e?.id as string,
				name: "web",
				slug: "web",
				kind: "application",
				spec,
			})
			.returning();
		const [m] = await db()
			.insert(mount)
			.values({
				serviceId: s?.id as string,
				kind: "volume",
				target: "/data",
				volumeName: "data",
			})
			.returning();
		const [d] = await db()
			.insert(deployment)
			.values({ serviceId: s?.id as string, trigger: "api" })
			.returning();
		await w.ctx.bus.publish(
			"deployment.queued",
			orgId,
			{ type: "deployment", id: d?.id as string },
			{ serviceId: s?.id },
		);
		expect((await waitForDeployment(db(), d?.id as string)).status).toBe(
			"healthy",
		);
		return {
			envId: e?.id as string,
			serviceId: s?.id as string,
			volume: `${PREFIX}${dockerName("vol", m?.id as string)}`,
		};
	}

	const volumeLabels = async (name: string) =>
		(await docker.volumes.list({ name: [name] })).find((v) => v.Name === name)
			?.Labels;

	beforeAll(async () => {
		await cleanup(AREA);
		sh("docker", "pull", "-q", "busybox:1.37");
		const cfg = await workerConfig(await startInfra(AREA), AREA);
		w = await startWorker({ ...cfg, LS_ORPHAN_GRACE_MS: 0 });
		orgId = `org_${crypto.randomUUID().slice(0, 8)}`;
		await db()
			.insert(organization)
			.values({ id: orgId, name: "Test", slug: orgId, createdAt: new Date() });
		const [p] = await db()
			.insert(project)
			.values({ organizationId: orgId, name: "P", slug: "p" })
			.returning();
		projectId = p?.id as string;
	}, 120_000);

	afterAll(async () => {
		await w?.stop();
		await cleanup(AREA);
	}, 120_000);

	test("an expired preview goes with its volumes; other orphaned volumes are kept", async () => {
		const prod = await deployed("production", false);
		const pr = await deployed("pr-1", true);
		expect((await volumeLabels(pr.volume))?.["logistack.disposable"]).toBe(
			"true",
		);
		expect(
			(await volumeLabels(prod.volume))?.["logistack.disposable"],
		).toBeUndefined();

		expect(await expirePreviews(w.ctx)).toEqual([pr.envId]);
		expect(await expirePreviews(w.ctx)).toEqual([]);
		// Production's service row goes too, so both volumes are orphans: only the preview's may go.
		await db().delete(service).where(eq(service.id, prod.serviceId));

		const deadline = Date.now() + 90_000;
		while ((await volumeLabels(pr.volume)) && Date.now() < deadline) {
			await sweepOrphans(w.ctx);
			await Bun.sleep(1_000);
		}
		expect(await volumeLabels(pr.volume)).toBeUndefined();
		expect(await volumeLabels(prod.volume)).toBeDefined();
		const left = (await docker.services.list({ name: [PREFIX] })).map(
			(s) => s.Spec.Name,
		);
		expect(left).not.toContain(`${PREFIX}${dockerName("svc", pr.serviceId)}`);
	}, 240_000);
});
