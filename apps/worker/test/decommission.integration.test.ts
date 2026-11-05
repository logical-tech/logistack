// Real Swarm, Postgres and Redis: decommissioning a fake Dokploy (`ls-test-mig7-*`). Its Postgres
// keeps its password in a Swarm secret, as Dokploy 0.26.6+ does. Opt in with WORKER_IT=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decommissionBlocker } from "@logistack/core";
import {
	environment,
	type MigrationSourceState,
	migration,
	migrationBridge,
	migrationItem,
	organization,
	project,
	service,
} from "@logistack/db";
import { eq } from "drizzle-orm";
import { decommission } from "../src/decommission.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";
import { svcName } from "../src/load.ts";
import { cleanup, hasDocker, sh, startInfra, workerConfig } from "./harness.ts";

const enabled = hasDocker && process.env.WORKER_IT === "1";

const T = "ls-test-mig7-";
const NET = `${T}net`;
const SECRET = `${T}pgpass`;
const PG = `${T}postgres`;
const CORE = `${T}dokploy`;
const TRAEFIK = `${T}traefik`;
const WEB = `${T}web`;
const LEFT = `${T}left`;
const SCRATCH = `${T}scratch`;

const quiet = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" });
const exists = (kind: "service" | "container" | "network", name: string) =>
	quiet("docker", kind, "inspect", name).exitCode === 0;

function removeFakes() {
	quiet("docker", "service", "rm", PG, CORE, WEB, LEFT, TRAEFIK);
	quiet("docker", "rm", "-f", TRAEFIK, SCRATCH);
	for (let i = 0; i < 60; i++) {
		if (
			quiet("docker", "network", "rm", NET).exitCode === 0 ||
			!exists("network", NET)
		)
			break;
		Bun.sleepSync(500);
	}
	quiet("docker", "secret", "rm", SECRET);
}

const service_ = (name: string, ...args: string[]) =>
	sh(
		"docker",
		"service",
		"create",
		"-q",
		"--name",
		name,
		"--label",
		"logistack.test=mig7",
		...args,
	);

describe.skipIf(!enabled)("decommissioning Dokploy on the real Swarm", () => {
	let w: RunningWorker;
	let orgId: string;
	let migrationId: string;
	let bridged: string;
	let root: string;
	let archiveDir: string;
	const db = () => w.ctx.db;

	beforeAll(async () => {
		await cleanup();
		removeFakes();
		sh("docker", "pull", "-q", "postgres:16-alpine");
		sh("docker", "pull", "-q", "busybox:1.37");
		root = mkdtempSync(join(tmpdir(), `${T}etc-`));
		mkdirSync(join(root, "compose", "blog-abc123", "code"), {
			recursive: true,
		});
		writeFileSync(
			join(root, "compose", "blog-abc123", "code", "docker-compose.yml"),
			"services: {}\n",
		);
		archiveDir = mkdtempSync(join(tmpdir(), `${T}archive-`));

		sh(
			"docker",
			"network",
			"create",
			"-d",
			"overlay",
			"--attachable",
			"--label",
			"logistack.test=mig7",
			// Its own range: Swarm hands a freed subnet to the next suite's network at once.
			"--subnet",
			"10.231.7.0/24",
			NET,
		);
		Bun.spawnSync(
			[
				"docker",
				"secret",
				"create",
				"--label",
				"logistack.test=mig7",
				SECRET,
				"-",
			],
			{
				stdin: new TextEncoder().encode("fake-dokploy-pg-password"),
			},
		);
		service_(
			PG,
			"--network",
			NET,
			"--secret",
			`source=${SECRET},target=pgpass`,
			"-e",
			"POSTGRES_USER=dokploy",
			"-e",
			"POSTGRES_DB=dokploy",
			"-e",
			"POSTGRES_PASSWORD_FILE=/run/secrets/pgpass",
			"postgres:16-alpine",
		);
		service_(CORE, "--network", NET, "busybox:1.37", "sleep", "3600");
		service_(WEB, "--replicas", "0", "busybox:1.37", "sleep", "3600");
		service_(LEFT, "--network", NET, "busybox:1.37", "sleep", "3600");
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			TRAEFIK,
			"--label",
			"logistack.test=mig7",
			"busybox:1.37",
			"sleep",
			"3600",
		);

		// Dokploy's data, written once its Postgres answers.
		for (let i = 0; ; i++) {
			const id = sh(
				"docker",
				"ps",
				"-q",
				"--filter",
				`label=com.docker.swarm.service.name=${PG}`,
			);
			const ok =
				id &&
				quiet(
					"docker",
					"exec",
					id,
					"psql",
					"-U",
					"dokploy",
					"-d",
					"dokploy",
					"-c",
					"create table project(name text); insert into project values ('kept-row')",
				).exitCode === 0;
			if (ok) break;
			if (i > 120) throw new Error("fake dokploy-postgres never answered");
			await Bun.sleep(1000);
		}

		const cfg = await workerConfig(await startInfra());
		Object.assign(cfg, {
			LS_DOKPLOY_NETWORK: NET,
			LS_DOKPLOY_POSTGRES: PG,
			LS_DOKPLOY_SERVICES: `${CORE},${PG}`,
			LS_DOKPLOY_TRAEFIK: TRAEFIK,
			LS_DOKPLOY_ROOT: root,
			LS_MIGRATION_ARCHIVE_DIR: archiveDir,
		});
		w = await startWorker(cfg);
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
				importedFrom: `dokploy:${WEB}`,
				spec: {
					kind: "application",
					source: { type: "image", image: "busybox:1.37" },
					build: { type: "image" },
					ports: [],
					replicas: 1,
					resources: {},
					placement: [],
				},
			})
			.returning();
		// The LogiStack service as the bridge left it: on Dokploy's network.
		bridged = svcName(w.ctx, s?.id as string);
		service_(bridged, "--network", NET, "busybox:1.37", "sleep", "3600");

		const [m] = await db()
			.insert(migration)
			.values({
				organizationId: orgId,
				source: "dokploy",
				status: "imported",
				proxyState: {
					result: {
						status: "switched",
						at: new Date().toISOString(),
						probes: [],
					},
				},
			})
			.returning();
		migrationId = m?.id as string;
		await db()
			.insert(migrationBridge)
			.values({ serviceId: s?.id as string, migrationId, aliases: ["web"] });
		const item = (
			sourceId: string,
			status: "cut_over" | "skipped" | "imported",
			sourceState?: MigrationSourceState,
		) => ({
			migrationId,
			kind: "application",
			sourceId,
			name: sourceId,
			position: 0,
			status,
			planEncrypted: "unused",
			targets: {},
			...(sourceState && { sourceState }),
		});
		await db()
			.insert(migrationItem)
			.values([
				item("web", "cut_over", { services: { [WEB]: 1 }, containers: [] }),
				item("left", "skipped"),
				item("pending", "imported"),
			]);
	}, 300_000);

	afterAll(async () => {
		await w?.stop();
		await cleanup();
		removeFakes();
		for (const d of [root, archiveDir])
			if (d) rmSync(d, { recursive: true, force: true });
	}, 120_000);

	test("it refuses while an item is neither moved nor left on Dokploy", async () => {
		expect(
			decommissionBlocker(
				[{ status: "cut_over" }, { status: "rolled_back" }],
				true,
			),
		).toContain("1 item");
		expect(decommissionBlocker([{ status: "cut_over" }], false)).toContain(
			"proxy",
		);
		await expect(decommission(w.ctx, migrationId)).rejects.toThrow(
			"cannot remove Dokploy yet",
		);
		expect(exists("service", PG)).toBe(true);
	});

	test("it archives Dokploy, then removes only what it owns", async () => {
		await db()
			.update(migrationItem)
			.set({ status: "skipped" })
			.where(eq(migrationItem.sourceId, "pending"));
		const state = await decommission(w.ctx, migrationId);
		expect(state?.result).toMatchObject({ status: "done" });
		const dir = state?.archive?.path as string;
		for (const f of ["dokploy.dump", "etc-dokploy.tar.gz", "inventory.json"])
			expect(existsSync(join(dir, f))).toBe(true);
		expect(await Bun.file(join(dir, "inventory.json")).json()).toContainEqual(
			expect.objectContaining({ sourceId: "web", status: "cut_over" }),
		);
		expect(sh("tar", "-tzf", join(dir, "etc-dokploy.tar.gz"))).toContain(
			"docker-compose.yml",
		);

		// The dump restores into a scratch Postgres with Dokploy's data in it.
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			SCRATCH,
			"--label",
			"logistack.test=mig7",
			"-e",
			"POSTGRES_PASSWORD=x",
			"-v",
			`${dir}:/a:ro`,
			"postgres:16-alpine",
		);
		for (
			let i = 0;
			quiet("docker", "exec", SCRATCH, "pg_isready", "-U", "postgres")
				.exitCode !== 0;
			i++
		) {
			if (i > 60) throw new Error("scratch Postgres never answered");
			await Bun.sleep(1000);
		}
		await Bun.sleep(1500);
		sh(
			"docker",
			"exec",
			SCRATCH,
			"pg_restore",
			"-U",
			"postgres",
			"-d",
			"postgres",
			"--no-owner",
			"/a/dokploy.dump",
		);
		expect(
			sh(
				"docker",
				"exec",
				SCRATCH,
				"psql",
				"-U",
				"postgres",
				"-tAc",
				"select name from project",
			),
		).toBe("kept-row");

		// Dokploy's own services, Traefik and the migrated source are gone; what stays on Dokploy stays.
		for (const name of [PG, CORE, WEB])
			expect(exists("service", name)).toBe(false);
		expect(exists("container", TRAEFIK)).toBe(false);
		expect(exists("service", LEFT)).toBe(true);
		expect(state?.removed).toEqual(
			expect.arrayContaining([PG, CORE, WEB, TRAEFIK]),
		);
		// The migrated service left the bridge; the network stays while the left item uses it.
		const nets = sh(
			"docker",
			"service",
			"inspect",
			bridged,
			"--format",
			"{{json .Spec.TaskTemplate.Networks}}",
		);
		expect(nets).not.toContain(
			sh("docker", "network", "inspect", NET, "--format", "{{.Id}}"),
		);
		expect(state?.kept).toEqual(
			expect.arrayContaining([
				{ name: "left", reason: "stays on Dokploy" },
				expect.objectContaining({ name: NET }),
			]),
		);
		const [m] = await db()
			.select()
			.from(migration)
			.where(eq(migration.id, migrationId));
		expect(m?.status).toBe("decommissioned");
	}, 300_000);
});
