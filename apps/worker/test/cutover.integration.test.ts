// Real Swarm, Postgres and Redis: a fake Dokploy (`ls-test-mig-*`) cut over to LogiStack and back.
// Opt in with WORKER_IT=1; takes a few minutes (rollout monitor, one failing deployment).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApplicationSpec } from "@logistack/contracts";
import { encrypt } from "@logistack/core";
import {
	environment,
	migration,
	migrationItem,
	organization,
	project,
	service,
} from "@logistack/db";
import { eq } from "drizzle-orm";
import { inspectService } from "../src/apply.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";
import { svcName } from "../src/load.ts";
import { cutOver, rollBack } from "../src/migration.ts";
import { cleanup, hasDocker, sh, startInfra, workerConfig } from "./harness.ts";

const enabled = hasDocker && process.env.WORKER_IT === "1";

/** Fake Dokploy objects; removed by these exact names only. */
const MIG = "ls-test-mig-";
const NET = `${MIG}net`;
const WEB = `${MIG}web`;
const BROKEN = `${MIG}broken`;
const BLOG = `${MIG}blog`;
const BLOG_APP = `${MIG}blog-app`;
const BLOG_DATA = `${MIG}blog-data`;

const quiet = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" });

function removeFakes() {
	quiet("docker", "service", "rm", WEB, BROKEN);
	quiet("docker", "rm", "-f", BLOG_APP);
	// Service tasks take a few seconds to exit after the service is removed.
	for (let i = 0; i < 60; i++) {
		if (quiet("docker", "network", "rm", NET).exitCode !== 0)
			Bun.sleepSync(500);
		else break;
	}
	quiet("docker", "volume", "rm", BLOG_DATA);
}

/** An httpd on 8080 answering `body`. */
const httpd = (body: string) => [
	"sh",
	"-c",
	`mkdir -p /www && echo ${body} > /www/index.html && httpd -f -p 8080 -h /www`,
];

/** What a client on Dokploy's network gets from `host`. */
const probe = (host: string) =>
	Bun.spawnSync(
		[
			"docker",
			"run",
			"--rm",
			"--label",
			"logistack.test=mig",
			"--network",
			NET,
			"busybox:1.37",
			"wget",
			"-q",
			"-T",
			"3",
			"-O",
			"-",
			`http://${host}:8080/`,
		],
		{ stderr: "ignore" },
	)
		.stdout.toString()
		.trim();

const replicas = (name: string) =>
	Number(
		sh(
			"docker",
			"service",
			"inspect",
			name,
			"--format",
			"{{.Spec.Mode.Replicated.Replicas}}",
		),
	);

describe.skipIf(!enabled)("migration cutover on the real Swarm", () => {
	let w: RunningWorker;
	let envId: string;
	let migrationId: string;
	const ctx = () => w.ctx;
	const db = () => w.ctx.db;

	async function imported(
		name: string,
		spec: ApplicationSpec,
		plan: { kind: string; adopted: boolean },
	) {
		const [svc] = await db()
			.insert(service)
			.values({
				environmentId: envId,
				name,
				slug: name,
				kind: "application",
				spec,
				importedFrom: `dokploy:${name}`,
			})
			.returning();
		const id = svc?.id as string;
		const [item] = await db()
			.insert(migrationItem)
			.values({
				migrationId,
				kind: plan.kind,
				sourceId: name,
				name,
				position: 0,
				status: "imported",
				targets: { [name]: id },
				planEncrypted: await encrypt(
					ctx().masterKey,
					JSON.stringify({
						type: "service",
						item: {
							kind: plan.kind,
							appName: plan.kind === "compose" ? BLOG : name,
							services: [
								{
									slug: name,
									running: true,
									adoptedVolumes: plan.adopted ? [{ volume: BLOG_DATA }] : [],
								},
							],
						},
					}),
				),
			})
			.returning();
		return { serviceId: id, itemId: item?.id as string };
	}

	const itemRow = async (id: string) =>
		(
			await db().select().from(migrationItem).where(eq(migrationItem.id, id))
		)[0];

	const app = (body: string): ApplicationSpec => ({
		kind: "application",
		source: { type: "image", image: "busybox:1.37" },
		build: { type: "image" },
		ports: [],
		replicas: 1,
		resources: {},
		placement: [],
		command: httpd(body),
		healthcheck: {
			type: "command",
			command: ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"],
		},
	});

	beforeAll(async () => {
		await cleanup();
		removeFakes();
		sh("docker", "pull", "-q", "busybox:1.37");
		sh(
			"docker",
			"network",
			"create",
			"-d",
			"overlay",
			"--attachable",
			"--label",
			"logistack.test=mig",
			NET,
		);
		const cfg = await workerConfig(await startInfra());
		cfg.LS_DOKPLOY_NETWORK = NET;
		w = await startWorker(cfg);
		const orgId = `org_${crypto.randomUUID().slice(0, 8)}`;
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
		const [m] = await db()
			.insert(migration)
			.values({ organizationId: orgId, source: "dokploy", status: "imported" })
			.returning();
		migrationId = m?.id as string;
	}, 180_000);

	afterAll(async () => {
		await w?.stop();
		await cleanup();
		removeFakes();
	}, 180_000);

	test("a stateless app takes over Dokploy's name, then hands it back", async () => {
		sh(
			"docker",
			"service",
			"create",
			"-q",
			"--name",
			WEB,
			"--label",
			"logistack.test=mig",
			"--network",
			NET,
			"busybox:1.37",
			...httpd("dokploy"),
		);
		const { serviceId, itemId } = await imported(WEB, app("logistack"), {
			kind: "application",
			adopted: false,
		});
		for (let i = 0; i < 60 && probe(WEB) !== "dokploy"; i++)
			await Bun.sleep(500);
		expect(probe(WEB)).toBe("dokploy");

		const events: string[] = [];
		ctx().bus.onEvent((e) => {
			if (e.type === "migration.item_changed" && e.payload.itemId === itemId)
				events.push(String(e.payload.status));
		});
		await cutOver(ctx(), itemId);
		expect(await itemRow(itemId)).toMatchObject({
			status: "cut_over",
			lastError: null,
			sourceState: { services: { [WEB]: 1 }, containers: [] },
		});
		expect(replicas(WEB)).toBe(0);
		expect(probe(WEB)).toBe("logistack");

		await rollBack(ctx(), itemId);
		expect((await itemRow(itemId))?.status).toBe("rolled_back");
		for (let i = 0; i < 50 && events.length < 2; i++) await Bun.sleep(50);
		expect(events).toEqual(["cut_over", "rolled_back"]);
		expect(replicas(WEB)).toBe(1);
		expect(replicas(svcName(ctx(), serviceId))).toBe(0);
		const [row] = await db()
			.select({ desiredState: service.desiredState })
			.from(service)
			.where(eq(service.id, serviceId));
		expect(row?.desiredState).toBe("stopped");
		for (let i = 0; i < 60 && probe(WEB) !== "dokploy"; i++)
			await Bun.sleep(500);
		expect(probe(WEB)).toBe("dokploy");
	}, 300_000);

	test("a deployment that never gets healthy rolls back on its own", async () => {
		sh(
			"docker",
			"service",
			"create",
			"-q",
			"--name",
			BROKEN,
			"--label",
			"logistack.test=mig",
			"--network",
			NET,
			"busybox:1.37",
			...httpd("dokploy"),
		);
		const { itemId } = await imported(
			BROKEN,
			{ ...app("never"), command: ["sh", "-c", "exit 1"] },
			{ kind: "application", adopted: false },
		);
		await cutOver(ctx(), itemId);
		const item = await itemRow(itemId);
		expect(item?.status).toBe("rolled_back");
		expect(item?.lastError).toContain("deployment");
		expect(replicas(BROKEN)).toBe(1);
	}, 400_000);

	test("a compose with a volume stops Dokploy's containers before LogiStack starts", async () => {
		sh(
			"docker",
			"volume",
			"create",
			"--label",
			"logistack.test=mig",
			BLOG_DATA,
		);
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			BLOG_APP,
			"--label",
			"logistack.test=mig",
			"--label",
			`com.docker.compose.project=${BLOG}`,
			"--network",
			NET,
			"-v",
			`${BLOG_DATA}:/data`,
			"busybox:1.37",
			"sleep",
			"3600",
		);
		const { serviceId, itemId } = await imported(BLOG_APP, app("blog"), {
			kind: "compose",
			adopted: true,
		});
		await cutOver(ctx(), itemId);
		expect(await itemRow(itemId)).toMatchObject({ status: "cut_over" });
		const state = () =>
			sh("docker", "inspect", BLOG_APP, "--format", "{{.State.Status}}");
		expect(state()).toBe("exited");
		expect(
			await inspectService(ctx(), svcName(ctx(), serviceId)),
		).toBeDefined();

		await rollBack(ctx(), itemId);
		expect(state()).toBe("running");
		expect(replicas(svcName(ctx(), serviceId))).toBe(0);
	}, 300_000);
});
