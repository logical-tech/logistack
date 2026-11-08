import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EventEnvelope, ServiceSpec } from "@logistack/contracts";
import { deriveSecretsKek, importMasterKey } from "@logistack/core";
import {
	createDb,
	type Db,
	environment,
	imageScan,
	imageVulnerability,
	organization,
	project,
	service,
	serviceImage,
} from "@logistack/db";
import { createDockerClient, managedLabels } from "@logistack/docker";
import { and, eq } from "drizzle-orm";
import { createBus, setLogLevel } from "../src/bus.ts";
import type { Ctx } from "../src/ctx.ts";
import { svcName } from "../src/load.ts";
import type { NodeRunner } from "../src/node-runner.ts";
import type { Queues } from "../src/queues.ts";
import { processScanJob, runTrivy } from "../src/vulnscan.ts";
import { cleanup, hasDocker, sh, startInfra, workerConfig } from "./harness.ts";

/** Objects here are named `ls-test-vulnscan-*` and labelled `logistack.test=vulnscan`. */
const AREA = "vulnscan";
/** Alpine 3.10.0 ships musl 1.1.22-r2: CVE-2019-14697, critical, fixed in 1.1.22-r3. */
const VULNERABLE = "alpine:3.10.0";
const LOCAL = `ls-test-${AREA}-local:1`;

describe.skipIf(!hasDocker)("vulnerability scanning", () => {
	let ctx: Ctx;
	let db: Db;
	const events: EventEnvelope[] = [];
	let serviceId = "";

	beforeAll(async () => {
		setLogLevel("silent");
		await cleanup(AREA);
		const infra = await startInfra(AREA);
		const cfg = await workerConfig(infra, AREA);
		db = createDb(cfg.DATABASE_URL, { onnotice: () => {} });
		ctx = {
			cfg,
			db,
			docker: createDockerClient(),
			bus: await createBus(cfg.REDIS_URL),
			masterKey: await importMasterKey(cfg.LOGISTACK_MASTER_KEY),
			secretsKek: await deriveSecretsKek(cfg.LOGISTACK_MASTER_KEY),
			queues: {} as Queues,
			nodes: {} as NodeRunner,
		};
		ctx.bus.onEvent((e) => events.push(e));

		await db.insert(organization).values({
			id: "org_v",
			name: "Vuln",
			slug: "vuln",
			createdAt: new Date(),
		});
		const [prj] = await db
			.insert(project)
			.values({ organizationId: "org_v", name: "Shop", slug: "shop" })
			.returning();
		const [env] = await db
			.insert(environment)
			.values({
				projectId: prj?.id as string,
				name: "Production",
				slug: "production",
				kind: "production",
				isDefault: true,
			})
			.returning();
		const [svc] = await db
			.insert(service)
			.values({
				environmentId: env?.id as string,
				name: "Old alpine",
				slug: "old-alpine",
				kind: "application",
				spec: {
					kind: "application",
					source: { type: "image", image: VULNERABLE },
				} as unknown as ServiceSpec,
			})
			.returning();
		serviceId = svc?.id as string;

		// A running Swarm service, as a deploy leaves it: Swarm pins the registry digest.
		sh("docker", "pull", "-q", VULNERABLE);
		const labels = {
			...managedLabels({ resource: serviceId, kind: "service", org: "org_v" }),
			...cfg.LS_SCOPE_LABELS,
		};
		await ctx.docker.services.create({
			Name: svcName(ctx, serviceId),
			Labels: labels,
			TaskTemplate: {
				ContainerSpec: {
					Image: VULNERABLE,
					Command: ["sleep", "3600"],
					Labels: labels,
				},
			},
			Mode: { Replicated: { Replicas: 1 } },
		});
		sh("docker", "tag", VULNERABLE, LOCAL);
	}, 180_000);

	afterAll(async () => {
		ctx?.bus.close();
		await db?.$client.end();
		Bun.spawnSync(["docker", "rmi", LOCAL], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await cleanup(AREA);
	}, 120_000);

	test("a deploy's image reports a critical CVE, once, with its fixed version", async () => {
		await processScanJob(ctx, { serviceId });

		const [link] = await db
			.select()
			.from(serviceImage)
			.where(eq(serviceImage.serviceId, serviceId));
		expect(link?.image).toBe(VULNERABLE);
		expect(link?.digest).toStartWith("sha256:");

		const [scan] = await db
			.select()
			.from(imageScan)
			.where(eq(imageScan.digest, link?.digest as string));
		expect(scan?.error).toBeNull();
		expect(scan?.status).toBe("succeeded");
		expect(scan?.counts?.critical).toBeGreaterThanOrEqual(1);

		const [musl] = await db
			.select()
			.from(imageVulnerability)
			.where(
				and(
					eq(imageVulnerability.digest, link?.digest as string),
					eq(imageVulnerability.vulnerabilityId, "CVE-2019-14697"),
				),
			);
		expect(musl?.severity).toBe("critical");
		expect(musl?.pkgName).toBe("musl");
		expect(musl?.fixedVersion).toBe("1.1.22-r3");

		for (let i = 0; i < 20 && !events.length; i++) await Bun.sleep(100);
		const vulnerable = events.filter((e) => e.type === "image.vulnerable");
		expect(vulnerable).toHaveLength(1);
		expect(vulnerable[0]?.resource).toEqual({ type: "service", id: serviceId });
		expect(vulnerable[0]?.payload.new).toContain("CVE-2019-14697");

		// A forced rescan finds the same criticals: nothing new to announce.
		events.length = 0;
		await processScanJob(ctx, { serviceId, force: true });
		await Bun.sleep(500);
		expect(events.filter((e) => e.type === "image.vulnerable")).toHaveLength(0);

		// No scan container is left behind.
		const left = await ctx.docker.containers.list(
			{ name: [`ls-test-${AREA}-ls-vulnscan-`] },
			true,
		);
		expect(left).toHaveLength(0);
	}, 600_000);

	test("an image built here and never pushed is read from the engine", async () => {
		const report = await runTrivy(ctx, {
			ref: LOCAL,
			local: true,
			orgId: "org_v",
		});
		const ids = (report.Results ?? []).flatMap((r) =>
			(r.Vulnerabilities ?? []).map((v) => v.VulnerabilityID),
		);
		expect(ids).toContain("CVE-2019-14697");
	}, 300_000);
});
