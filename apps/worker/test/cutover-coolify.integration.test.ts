// Real Swarm, Postgres and Redis: a fake Coolify (`ls-test-cool5-*`), plain containers on a local
// bridge with Traefik's docker provider in front, cut over to LogiStack and back through the
// bridge overlay. Opt in with WORKER_IT=1; takes a few minutes.
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
import type { ApplicationSpec } from "@logistack/contracts";
import { encrypt } from "@logistack/core";
import {
	domain,
	environment,
	migration,
	migrationBridge,
	migrationItem,
	organization,
	project,
	service,
} from "@logistack/db";
import { eq } from "drizzle-orm";
import { unfreeze } from "../src/coolify.ts";
import { decommission } from "../src/decommission.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";
import { cutOver, rollBack } from "../src/migration.ts";
import { cleanup, hasDocker, sh, startInfra, workerConfig } from "./harness.ts";

const enabled = hasDocker && process.env.WORKER_IT === "1";

/** Fake Coolify objects; removed by these exact names only. */
const P = "ls-test-cool5-";
const NET = `${P}net`;
const BRIDGE = `${P}bridge`;
const CONTROL = `${P}coolify`;
const PROXY = `${P}proxy`;
const DB = `${P}db`;
const CLIENT = `${P}client`;
const WEB = `${P}web`;
const PGDB = `${P}pgdb`;
const SECRET = `${P}dbpw`;
const SCRATCH = `${P}scratch`;
const MANAGED = "coolify.managed=ls-test-cool5";
const PORT = 18195;
const HOST = "cool5.test";

const quiet = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" });

function removeFakes() {
	quiet(
		"docker",
		"rm",
		"-f",
		"-v",
		CONTROL,
		PROXY,
		DB,
		CLIENT,
		WEB,
		PGDB,
		SCRATCH,
	);
	quiet("docker", "secret", "rm", SECRET);
	for (const net of [BRIDGE, NET])
		for (let i = 0; i < 60; i++) {
			if (quiet("docker", "network", "rm", net).exitCode !== 0)
				Bun.sleepSync(500);
			else break;
		}
}

const httpd = (body: string) => [
	"sh",
	"-c",
	`mkdir -p /www && echo ${body} > /www/index.html && httpd -f -p 8080 -h /www`,
];

/** A Coolify-managed container, as Coolify runs one: its compose project is the uuid. */
const coolifyContainer = (name: string, body: string, labels: string[] = []) =>
	sh(
		"docker",
		"run",
		"-d",
		"--name",
		name,
		"--network",
		NET,
		"--restart",
		"unless-stopped",
		"--label",
		"logistack.test=cool5",
		"--label",
		MANAGED,
		"--label",
		`com.docker.compose.project=${name}`,
		...labels.flatMap((l) => ["--label", l]),
		"busybox:1.37",
		...httpd(body),
	);

/** What a container still on Coolify gets from `host` by name. */
const fromClient = (host: string) =>
	Bun.spawnSync(
		[
			"docker",
			"exec",
			CLIENT,
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

/** What Coolify's Traefik answers for the site. */
const throughProxy = async () => {
	try {
		const r = await fetch(`http://127.0.0.1:${PORT}/`, {
			headers: { host: HOST },
			signal: AbortSignal.timeout(2000),
		});
		return r.ok ? (await r.text()).trim() : `HTTP ${r.status}`;
	} catch (e) {
		return String(e);
	}
};

const inspect = (name: string, format: string) =>
	sh("docker", "inspect", name, "--format", format);

describe.skipIf(!enabled)("Coolify cutover on the real Swarm", () => {
	let w: RunningWorker;
	let envId: string;
	let root: string;
	let archives: string;
	let migrationId: string;
	const ctx = () => w.ctx;
	const db = () => w.ctx.db;

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

	/** What the import leaves: the service, its bridge row and the item with its descriptor. */
	async function imported(
		uuid: string,
		slug: string,
		opts: { stateful: boolean; domain?: boolean },
	) {
		const [svc] = await db()
			.insert(service)
			.values({
				environmentId: envId,
				name: slug,
				slug,
				kind: "application",
				spec: app("logistack"),
				importedFrom: `coolify:${uuid}`,
			})
			.returning();
		const id = svc?.id as string;
		if (opts.domain)
			await db().insert(domain).values({
				serviceId: id,
				hostname: HOST,
				port: 8080,
				https: false,
				cert: "none",
			});
		await db()
			.insert(migrationBridge)
			.values({
				serviceId: id,
				migrationId,
				aliases: [slug, uuid],
				routes: !!opts.domain,
			});
		const [item] = await db()
			.insert(migrationItem)
			.values({
				migrationId,
				kind: opts.stateful ? "postgres" : "application",
				sourceId: uuid,
				name: slug,
				position: 0,
				status: "imported",
				targets: { [slug]: id },
				planEncrypted: await encrypt(
					ctx().masterKey,
					JSON.stringify({
						type: "service",
						item: {
							kind: opts.stateful ? "postgres" : "application",
							appName: uuid,
							source: {
								containerLabels: [
									MANAGED,
									`com.docker.compose.project=${uuid}`,
								],
								routedByLabels: !!opts.domain,
							},
							services: [
								{
									slug,
									running: true,
									adoptedVolumes: opts.stateful ? [{ volume: "x" }] : [],
									domains: opts.domain ? [{ hostname: HOST }] : [],
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

	beforeAll(async () => {
		await cleanup();
		removeFakes();
		sh("docker", "pull", "-q", "busybox:1.37");
		sh(
			"docker",
			"network",
			"create",
			"--attachable",
			"--label",
			"logistack.test=cool5",
			NET,
		);
		// LogiStack's overlay, as install.sh leaves it; its own range.
		sh(
			"docker",
			"network",
			"create",
			"-d",
			"overlay",
			"--attachable",
			"--label",
			"logistack.test=cool5",
			"--subnet",
			"10.231.5.0/24",
			BRIDGE,
		);
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			CONTROL,
			"--restart",
			"always",
			"--label",
			"logistack.test=cool5",
			"busybox:1.37",
			"sleep",
			"3600",
		);
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			PROXY,
			"--network",
			NET,
			"-p",
			`127.0.0.1:${PORT}:80`,
			"--label",
			"logistack.test=cool5",
			"-v",
			"/var/run/docker.sock:/var/run/docker.sock:ro",
			"traefik:v3.6",
			"--entrypoints.http.address=:80",
			"--providers.docker.exposedbydefault=false",
			// Coolify's Traefik has no network constraint; this one must only see this suite.
			`--providers.docker.constraints=Label(\`logistack.test\`, \`cool5\`) || LabelRegex(\`traefik.docker.network\`, \`${BRIDGE}\`)`,
		);
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			CLIENT,
			"--network",
			NET,
			"--label",
			"logistack.test=cool5",
			"--label",
			MANAGED,
			"busybox:1.37",
			"sleep",
			"3600",
		);
		// Coolify's own database, its password in the secret install.sh would have made.
		const pw = `fake-cool5-${crypto.randomUUID().slice(0, 8)}`;
		Bun.spawnSync(
			[
				"docker",
				"secret",
				"create",
				"--label",
				"logistack.test=cool5",
				SECRET,
				"-",
			],
			{
				stdin: new Blob([pw]),
			},
		);
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			PGDB,
			"--network",
			NET,
			"--label",
			"logistack.test=cool5",
			"-e",
			"POSTGRES_USER=coolify",
			"-e",
			"POSTGRES_DB=coolify",
			"-e",
			`POSTGRES_PASSWORD=${pw}`,
			"postgres:16-alpine",
		);
		root = mkdtempSync(join(tmpdir(), "ls-test-cool5-root-"));
		mkdirSync(join(root, "source"));
		mkdirSync(join(root, "backups"));
		writeFileSync(join(root, "source", ".env"), "APP_KEY=fake\n");
		writeFileSync(join(root, "backups", "big.dmp"), "x");
		archives = mkdtempSync(join(tmpdir(), "ls-test-cool5-archive-"));
		const cfg = await workerConfig(await startInfra());
		Object.assign(cfg, {
			LS_COOLIFY_DB: PGDB,
			LS_COOLIFY_DB_SECRET: SECRET,
			LS_COOLIFY_CONTAINERS: `${CONTROL},${PGDB}`,
			LS_COOLIFY_SOURCE_NETWORK: NET,
			LS_COOLIFY_ROOT: root,
			LS_MIGRATION_ARCHIVE_DIR: archives,
			LS_COOLIFY_NETWORK: BRIDGE,
			LS_COOLIFY_PROXY: PROXY,
			LS_COOLIFY_CONTROL: CONTROL,
			LS_COOLIFY_MANAGED_LABEL: MANAGED,
			// Coolify's Traefik sees container events at once; a short settle is enough.
			LS_BRIDGE_SETTLE_MS: 3000,
		});
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
			.values({ organizationId: orgId, source: "coolify", status: "imported" })
			.returning();
		migrationId = m?.id as string;
	}, 180_000);

	afterAll(async () => {
		await w?.stop();
		await cleanup();
		removeFakes();
	}, 180_000);

	test("a database takes over its uuid for Coolify's apps; Coolify is frozen first", async () => {
		coolifyContainer(DB, "coolify");
		for (let i = 0; i < 40 && fromClient(DB) !== "coolify"; i++)
			await Bun.sleep(250);
		expect(fromClient(DB)).toBe("coolify");
		const { itemId } = await imported(DB, DB, { stateful: true });

		await cutOver(ctx(), itemId);
		const item = await itemRow(itemId);
		expect(item?.status).toBe("cut_over");
		expect(item?.sourceState?.containers).toHaveLength(1);
		// Frozen: stopped, and nothing brings it back on a reboot.
		expect(
			inspect(CONTROL, "{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}"),
		).toBe("false no");
		const [mig] = await db()
			.select()
			.from(migration)
			.where(eq(migration.id, migrationId));
		expect(mig?.freeze?.containers).toEqual([
			expect.objectContaining({
				name: CONTROL,
				restartPolicy: "always",
				running: true,
			}),
		]);
		// The bridge: Coolify's client and proxy joined LogiStack's overlay.
		expect(
			inspect(
				CLIENT,
				"{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
			),
		).toContain(BRIDGE);
		expect(
			inspect(
				PROXY,
				"{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
			),
		).toContain(BRIDGE);
		expect(inspect(DB, "{{.State.Running}}")).toBe("false");
		for (let i = 0; i < 40 && fromClient(DB) !== "logistack"; i++)
			await Bun.sleep(250);
		expect(fromClient(DB)).toBe("logistack");

		await rollBack(ctx(), itemId);
		expect((await itemRow(itemId))?.status).toBe("rolled_back");
		expect(inspect(DB, "{{.State.Running}}")).toBe("true");
		for (let i = 0; i < 40 && fromClient(DB) !== "coolify"; i++)
			await Bun.sleep(250);
		expect(fromClient(DB)).toBe("coolify");
	}, 300_000);

	test("a site keeps answering through Coolify's Traefik while it moves", async () => {
		coolifyContainer(WEB, "coolify", [
			"traefik.enable=true",
			`traefik.http.routers.${WEB}.rule=Host(\`${HOST}\`)`,
			`traefik.http.routers.${WEB}.entrypoints=http`,
			`traefik.http.services.${WEB}.loadbalancer.server.port=8080`,
		]);
		for (let i = 0; i < 40 && (await throughProxy()) !== "coolify"; i++)
			await Bun.sleep(250);
		expect(await throughProxy()).toBe("coolify");
		const { itemId } = await imported(WEB, "web", {
			stateful: false,
			domain: true,
		});

		// Probe every 200 ms while the cutover runs: no answer may be anything but a page.
		const answers: string[] = [];
		let done = false;
		const prober = (async () => {
			while (!done) {
				answers.push(await throughProxy());
				await Bun.sleep(200);
			}
		})();
		await cutOver(ctx(), itemId);
		for (let i = 0; i < 20 && (await throughProxy()) !== "logistack"; i++)
			await Bun.sleep(250);
		done = true;
		await prober;

		expect((await itemRow(itemId))?.status).toBe("cut_over");
		expect(inspect(WEB, "{{.State.Running}}")).toBe("false");
		expect(await throughProxy()).toBe("logistack");
		const failed = answers.filter((a) => a !== "coolify" && a !== "logistack");
		console.log("ANSWERS", JSON.stringify(answers));
		expect({ probes: answers.length, failed }).toEqual({
			probes: answers.length,
			failed: [],
		});
	}, 300_000);

	test("unfreezing gives Coolify back its restart policy and starts it", async () => {
		await unfreeze(ctx(), migrationId);
		expect(
			inspect(CONTROL, "{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}"),
		).toBe("true always");
		const [mig] = await db()
			.select()
			.from(migration)
			.where(eq(migration.id, migrationId));
		expect(mig?.freeze).toBeNull();
	}, 60_000);

	test("decommission archives Coolify, then removes only what it owns", async () => {
		for (
			let i = 0;
			quiet("docker", "exec", PGDB, "pg_isready", "-U", "coolify").exitCode !==
			0;
			i++
		) {
			if (i > 60) throw new Error("Coolify's Postgres never answered");
			await Bun.sleep(1000);
		}
		await Bun.sleep(1500);
		sh(
			"docker",
			"exec",
			PGDB,
			"psql",
			"-U",
			"coolify",
			"-c",
			"create table projects (name text); insert into projects values ('kept-row')",
		);
		// The database was moved back and is left on Coolify; traffic is switched.
		await db()
			.update(migrationItem)
			.set({ status: "skipped" })
			.where(eq(migrationItem.sourceId, DB));
		await db()
			.update(migration)
			.set({
				proxyState: {
					result: {
						status: "switched",
						at: new Date().toISOString(),
						probes: [],
					},
				},
			})
			.where(eq(migration.id, migrationId));

		const state = await decommission(ctx(), migrationId);
		expect(state?.result).toMatchObject({ status: "done" });
		const dir = state?.archive?.path as string;
		for (const f of ["coolify.dump", "data-coolify.tar.gz", "inventory.json"])
			expect(existsSync(join(dir, f))).toBe(true);
		const listing = sh("tar", "-tzf", join(dir, "data-coolify.tar.gz"));
		expect(listing).toContain("source/.env");
		expect(listing).not.toContain("big.dmp");

		// The dump restores with Coolify's data in it.
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			SCRATCH,
			"--label",
			"logistack.test=cool5",
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
			"/a/coolify.dump",
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
				"select name from projects",
			),
		).toBe("kept-row");

		// Coolify's own containers, its proxy and the moved site are gone; the database left on it stays.
		const exists = (name: string) =>
			quiet("docker", "container", "inspect", name).exitCode === 0;
		for (const name of [CONTROL, PGDB, PROXY, WEB])
			expect(exists(name)).toBe(false);
		expect(exists(DB)).toBe(true);
		expect(state?.removed).toEqual(
			expect.arrayContaining([CONTROL, PGDB, PROXY]),
		);
		expect(state?.kept).toEqual(
			expect.arrayContaining([
				{
					name: DB,
					reason: "stays as it is, now without Coolify to manage it",
				},
				expect.objectContaining({ name: NET }),
			]),
		);
		// Coolify's containers left LogiStack's overlay; the bridge rows are gone.
		expect(
			inspect(
				CLIENT,
				"{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
			),
		).not.toContain(BRIDGE);
		expect(
			await db()
				.select()
				.from(migrationBridge)
				.where(eq(migrationBridge.migrationId, migrationId)),
		).toEqual([]);
		const [m] = await db()
			.select()
			.from(migration)
			.where(eq(migration.id, migrationId));
		expect(m?.status).toBe("decommissioned");
	}, 400_000);
});
