import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationSpec } from "@logistack/contracts";
import { encrypt } from "@logistack/core";
import {
	deployment,
	environment,
	instanceSettings,
	organization,
	project,
	registry,
	registryRetention,
	runMigrations,
	service,
} from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";
import {
	compileLocalRegistry,
	localRegistryName,
	syncLocalRegistry,
} from "../src/local-registry.ts";
import { pruneImages, tagsToDelete } from "../src/retention.ts";
import {
	BUILDKIT_CLIENT,
	hasDocker,
	sh,
	waitForDeployment,
} from "./harness.ts";

describe("compileLocalRegistry", () => {
	const input = {
		name: "ls-registry",
		image: "ghcr.io/project-zot/zot:v2.1.23",
		labels: { "logistack.managed": "true", "logistack.kind": "system" },
		config: { id: "cfg1", name: "ls-registry-config-abc" },
		htpasswd: { id: "sec1", name: "ls-registry-htpasswd-def" },
		network: "ls-ingress",
		volume: "ls-registry-data",
		constraints: ["node.id==n1"],
		publishPort: 0,
	};

	test("Zot on the ingress network with its volume, config and htpasswd", () => {
		const spec = compileLocalRegistry(input);
		const c = spec.TaskTemplate.ContainerSpec;
		expect(c.Image).toBe("ghcr.io/project-zot/zot:v2.1.23");
		expect(c.Args).toEqual(["serve", "/etc/zot/config.json"]);
		expect(c.Configs?.[0]?.File.Name).toBe("/etc/zot/config.json");
		expect(c.Secrets?.[0]?.File.Name).toBe("/etc/zot/htpasswd");
		expect(c.Mounts?.[0]).toMatchObject({
			Type: "volume",
			Source: "ls-registry-data",
			Target: "/var/lib/registry",
		});
		expect(spec.TaskTemplate.Networks).toEqual([
			{ Target: "ls-ingress", Aliases: ["ls-registry"] },
		]);
		expect(spec.TaskTemplate.Placement?.Constraints).toEqual(["node.id==n1"]);
		expect(spec.EndpointSpec).toBeUndefined();
	});

	test("the hash label is stable and changes with the spec", () => {
		const hash = (i: typeof input) =>
			compileLocalRegistry(i).Labels?.["logistack.spec-hash"];
		expect(hash(input)).toBe(hash({ ...input }));
		expect(hash(input)).not.toBe(hash({ ...input, publishPort: 5555 }));
		expect(hash(input)).not.toBe(
			hash({ ...input, htpasswd: { id: "sec2", name: "other" } }),
		);
	});
});

describe("tagsToDelete", () => {
	const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 0, min));
	const deps = [
		{ id: "dep_1", createdAt: at(1), status: "healthy" as const },
		{ id: "dep_2", createdAt: at(2), status: "failed" as const },
		{ id: "dep_3", createdAt: at(3), status: "failed" as const },
		{ id: "dep_4", createdAt: at(4), status: "failed" as const },
	];

	test("keeps the newest N and the one running now, ignores unknown tags", () => {
		expect(
			tagsToDelete(["dep_1", "dep_2", "dep_3", "dep_4", "check"], deps, 2),
		).toEqual(["dep_2"]);
		expect(tagsToDelete(["dep_1", "dep_4"], deps, 5)).toEqual([]);
	});
});

const PREFIX = "ls-test-git-";
const LABEL = { "logistack.test": "git" };
const enabled = hasDocker && process.env.WORKER_IT === "1";
const docker = createDockerClient();

/** Removes only objects whose name starts with ls-test-git-. */
async function cleanup() {
	const ours = (n: string | undefined) =>
		!!n?.replace(/^\//, "").startsWith(PREFIX);
	const ignore = () => {};
	for (const s of await docker.services.list({ name: [PREFIX] }))
		if (ours(s.Spec.Name)) await docker.services.remove(s.ID).catch(ignore);
	for (const c of await docker.containers.list({ name: [PREFIX] }, true))
		if (c.Names.some(ours))
			await docker.containers.remove(c.Id, true).catch(ignore);
	for (let i = 0; i < 40; i++) {
		const tasks = (await docker.containers.list({}, true)).filter((c) =>
			ours(c.Labels["com.docker.swarm.service.name"]),
		);
		if (!tasks.length) break;
		await Bun.sleep(500);
	}
	for (const c of await docker.configs.list({ name: [PREFIX] }))
		if (ours(c.Spec.Name)) await docker.configs.remove(c.ID).catch(ignore);
	for (const s of await docker.secrets.list({ name: [PREFIX] }))
		if (ours(s.Spec.Name)) await docker.secrets.remove(s.ID).catch(ignore);
	for (const n of await docker.networks.list({ name: [PREFIX] }))
		if (ours(n.Name)) await docker.networks.remove(n.Id).catch(ignore);
	for (const v of await docker.volumes.list({ name: [PREFIX] }))
		if (ours(v.Name)) await docker.volumes.remove(v.Name, true).catch(ignore);
}

async function infra() {
	const run = (name: string, image: string, p: number, ...env: string[]) => {
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			name,
			"--label",
			"logistack.test=git",
			"-p",
			`127.0.0.1::${p}`,
			...env.flatMap((e) => ["-e", e]),
			image,
		);
		return sh("docker", "port", name, `${p}/tcp`).split("\n")[0] as string;
	};
	const pg = run(
		`${PREFIX}pg`,
		"postgres:17-alpine",
		5432,
		"POSTGRES_PASSWORD=test",
	);
	const redis = run(`${PREFIX}redis`, "redis:7-alpine", 6379);
	const databaseUrl = `postgres://postgres:test@${pg}/postgres`;
	for (let i = 0; ; i++)
		try {
			await runMigrations(databaseUrl);
			break;
		} catch (e) {
			if (i > 60) throw e;
			await Bun.sleep(500);
		}
	for (const net of ["control", "ingress"])
		await docker.networks
			.create({
				Name: `${PREFIX}${net}`,
				Driver: "overlay",
				Attachable: true,
				Labels: LABEL,
			})
			.catch(() => {});
	return { databaseUrl, redisUrl: `redis://${redis}` };
}

async function repo(content: string) {
	const dir = await mkdtemp(join(tmpdir(), `${PREFIX}repo-`));
	await writeFile(
		join(dir, "Dockerfile"),
		`FROM busybox:1.37\nRUN mkdir /www && echo ${content} > /www/index.html\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n`,
	);
	const git = (...args: string[]) =>
		sh(
			"git",
			"-C",
			dir,
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			...args,
		);
	git("init", "-q", "-b", "main");
	git("add", ".");
	git("commit", "-q", "-m", content);
	return dir;
}

describe.skipIf(!enabled)("local registry on the real Swarm", () => {
	let w: RunningWorker;
	let orgId: string;
	let envId: string;
	let registryId: string;
	const port = 20000 + Math.floor(Math.random() * 20000);
	const host = `localhost:${port}`;
	const password = crypto.randomUUID();
	const basic = `Basic ${btoa(`logistack:${password}`)}`;
	const db = () => w.ctx.db;
	const v2 = (path: string, auth = true) =>
		fetch(`http://${host}/v2${path}`, {
			headers: auth ? { authorization: basic } : {},
		});

	beforeAll(async () => {
		await cleanup();
		sh("docker", "pull", "-q", "busybox:1.37");
		sh("docker", "pull", "-q", BUILDKIT_CLIENT);
		const i = await infra();
		const work = await mkdtemp(join(tmpdir(), PREFIX));
		w = await startWorker(
			loadConfig({
				DATABASE_URL: i.databaseUrl,
				REDIS_URL: i.redisUrl,
				LOGISTACK_MASTER_KEY: crypto
					.getRandomValues(new Uint8Array(32))
					.toBase64(),
				LS_WORK_DIR: work,
				LS_CONTROL_NETWORK: `${PREFIX}control`,
				LS_INGRESS_NETWORK: `${PREFIX}ingress`,
				LS_CADDY_SERVICE: `${PREFIX}caddy`,
				LS_BUILDCTL: JSON.stringify([
					"docker",
					"run",
					"--rm",
					"-i",
					"--name",
					`${PREFIX}buildctl`,
					"--label",
					"logistack.test=git",
					"--network",
					`${PREFIX}control`,
					"-v",
					`${work}:${work}`,
					"--entrypoint",
					"buildctl",
					BUILDKIT_CLIENT,
				]),
				LS_ALLOW_LOCAL_GIT: "true",
				LS_NAME_PREFIX: PREFIX,
				LS_SCOPE_LABELS: JSON.stringify(LABEL),
				LS_LOCAL_REGISTRY_PORT: String(port),
				LS_DEPLOY_TIMEOUT_MS: "180000",
				LS_RECONCILE_INTERVAL_MS: "0",
				LOG_LEVEL: "silent",
			}),
		);
		orgId = `org_${crypto.randomUUID().slice(0, 8)}`;
		await db()
			.insert(organization)
			.values({ id: orgId, name: "T", slug: orgId, createdAt: new Date() });
		await db()
			.insert(instanceSettings)
			.values({ setupCompleted: true, localRegistryEnabled: true });
		const [r] = await db()
			.insert(registry)
			.values({
				organizationId: orgId,
				kind: "local",
				url: host,
				username: "logistack",
				passwordEncrypted: await encrypt(w.ctx.masterKey, password),
				isDefault: true,
			})
			.returning();
		registryId = r?.id as string;
		await db().insert(registryRetention).values({ registryId, keepTags: 1 });
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
	}, 180_000);

	afterAll(async () => {
		await w?.stop();
		await cleanup();
		for (const n of [`${PREFIX}pg`, `${PREFIX}redis`])
			Bun.spawnSync(["docker", "rm", "-f", "-v", n], {
				stdout: "ignore",
				stderr: "ignore",
			});
	}, 180_000);

	test("switching it on runs Zot with generated credentials; a second sync is a no-op", async () => {
		expect(await syncLocalRegistry(w.ctx)).toBe("running");
		const svc = await docker.services.inspect(localRegistryName(w.ctx));
		expect(svc.Spec.Labels?.["logistack.managed"]).toBe("true");
		expect(svc.Spec.Labels?.["logistack.test"]).toBe("git");
		let ready = false;
		for (let i = 0; i < 120 && !ready; i++) {
			ready = await v2("/").then(
				(r) => r.ok,
				() => false,
			);
			if (!ready) await Bun.sleep(500);
		}
		expect(ready).toBe(true);
		expect((await v2("/", false)).status).toBe(401);
		// Swarm bumps the version itself (port allocation), so count our update calls instead.
		const update = w.ctx.docker.services.update;
		let updates = 0;
		w.ctx.docker.services.update = (...args) => {
			updates++;
			return update(...args);
		};
		try {
			expect(await syncLocalRegistry(w.ctx)).toBe("running");
		} finally {
			w.ctx.docker.services.update = update;
		}
		expect(updates).toBe(0);
	}, 120_000);

	test("the pipeline builds, pushes to it and deploys from it; retention prunes the older image", async () => {
		const ids: string[] = [];
		const spec = async (content: string): Promise<ApplicationSpec> => ({
			kind: "application",
			source: {
				type: "git",
				repository: `file://${await repo(content)}`,
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
		const [s] = await db()
			.insert(service)
			.values({
				environmentId: envId,
				name: "built",
				slug: "built",
				kind: "application",
				spec: await spec("one"),
			})
			.returning();
		const serviceId = s?.id as string;
		for (const content of ["one", "two"]) {
			if (content === "two")
				await db()
					.update(service)
					.set({ spec: await spec("two") })
					.where(eq(service.id, serviceId));
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
			const done = await waitForDeployment(db(), id, 300_000);
			expect(done.error).toBeNull();
			expect(done.status).toBe("healthy");
			expect((done as unknown as { seen: string[] }).seen).toContain("pushing");
			expect(done.imageRef).toStartWith(`${host}/`);
			ids.push(id);
		}
		const repoPath = (
			await db()
				.select()
				.from(deployment)
				.where(eq(deployment.id, ids[1] as string))
		)[0]?.imageRef
			?.slice(host.length + 1)
			.split(":")[0];
		const tags = async () =>
			(
				(await (await v2(`/${repoPath}/tags/list`)).json()) as {
					tags: string[];
				}
			).tags.sort();
		expect(await tags()).toEqual([...ids].sort());

		const { deleted } = await pruneImages(w.ctx);
		expect(deleted).toEqual([`${host}/${repoPath}:${ids[0]}`]);
		expect(await tags()).toEqual([ids[1] as string]);
	}, 700_000);

	test("off keeps the images volume; removing the registry row purges it", async () => {
		const volume = `${localRegistryName(w.ctx)}-data`;
		await db().update(instanceSettings).set({ localRegistryEnabled: false });
		expect(await syncLocalRegistry(w.ctx)).toBe("stopped");
		expect(
			(await docker.services.list({ name: [localRegistryName(w.ctx)] })).filter(
				(x) => x.Spec.Name === localRegistryName(w.ctx),
			),
		).toHaveLength(0);
		expect(
			(await docker.volumes.list({ name: [volume] })).map((v) => v.Name),
		).toContain(volume);
		await db().delete(registry).where(eq(registry.id, registryId));
		expect(await syncLocalRegistry(w.ctx)).toBe("purged");
		expect(
			(await docker.volumes.list({ name: [volume] })).map((v) => v.Name),
		).not.toContain(volume);
	}, 120_000);
});
