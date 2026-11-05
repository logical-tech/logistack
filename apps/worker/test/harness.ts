import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentStatus } from "@logistack/contracts";
import { isTerminal } from "@logistack/core";
import { type Db, deployment, runMigrations } from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";

/** Every Docker object this suite creates starts with this; cleanup touches nothing else. */
export const PREFIX = "ls-test-worker-";
export const LABEL = { "logistack.test": "worker" };
export const BUILDKIT_CLIENT = "moby/buildkit:v0.34.1";

export const hasDocker = (() => {
	try {
		return (
			Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" })
				.exitCode === 0
		);
	} catch {
		return false;
	}
})();

export function sh(...argv: string[]): string {
	const p = Bun.spawnSync(argv, { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`${argv.join(" ")} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

const docker = createDockerClient();

/** Starts `ls-test-worker-pg` and `ls-test-worker-redis` on free loopback ports. */
export async function startInfra() {
	const run = (name: string, image: string, port: number, ...env: string[]) => {
		Bun.spawnSync(["docker", "rm", "-f", "-v", name], {
			stdout: "ignore",
			stderr: "ignore",
		});
		sh(
			"docker",
			"run",
			"-d",
			"--name",
			name,
			"--label",
			"logistack.test=worker",
			"-p",
			`127.0.0.1::${port}`,
			...env.flatMap((e) => ["-e", e]),
			image,
		);
		return sh("docker", "port", name, `${port}/tcp`).split("\n")[0] as string;
	};
	const pg = run(
		`${PREFIX}pg`,
		"postgres:17-alpine",
		5432,
		"POSTGRES_PASSWORD=test",
	);
	const redis = run(`${PREFIX}redis`, "redis:7-alpine", 6379);
	const databaseUrl = `postgres://postgres:test@${pg}/postgres`;
	for (let i = 0; ; i++) {
		try {
			await runMigrations(databaseUrl);
			break;
		} catch (e) {
			if (i > 60) throw e;
			await Bun.sleep(500);
		}
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

export async function workerConfig(infra: {
	databaseUrl: string;
	redisUrl: string;
}) {
	const work = await mkdtemp(join(tmpdir(), PREFIX));
	const config = loadConfig({
		DATABASE_URL: infra.databaseUrl,
		REDIS_URL: infra.redisUrl,
		LOGISTACK_MASTER_KEY: Buffer.from(
			crypto.getRandomValues(new Uint8Array(32)),
		).toString("base64"),
		LS_WORK_DIR: work,
		LS_CONTROL_NETWORK: `${PREFIX}control`,
		LS_INGRESS_NETWORK: `${PREFIX}ingress`,
		LS_CADDY_SERVICE: `${PREFIX}caddy`,
		// buildctl runs in a client container next to the test buildkit; the checkout is bind-mounted.
		LS_BUILDCTL: JSON.stringify([
			"docker",
			"run",
			"--rm",
			"-i",
			"--name",
			`${PREFIX}buildctl`,
			"--label",
			"logistack.test=worker",
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
		LS_DEPLOY_TIMEOUT_MS: "180000",
		LS_RECONCILE_INTERVAL_MS: "0",
		LOG_LEVEL: "silent",
	});
	return config;
}

/** A one-commit git repo with a Dockerfile serving a static page on 8080. */
export async function fixtureRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `${PREFIX}repo-`));
	await writeFile(
		join(dir, "Dockerfile"),
		[
			"FROM busybox:1.37",
			"ARG LOGISTACK_COMMIT_SHA",
			'RUN mkdir /www && echo built-by-buildkit > /www/index.html && echo "$LOGISTACK_COMMIT_SHA" > /www/commit',
			'CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]',
			"",
		].join("\n"),
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
	git("commit", "-q", "-m", "fixture app");
	return dir;
}

export async function waitForDeployment(
	db: Db,
	id: string,
	timeoutMs = 240_000,
): Promise<typeof deployment.$inferSelect> {
	const deadline = Date.now() + timeoutMs;
	const seen: DeploymentStatus[] = [];
	for (;;) {
		const [d] = await db.select().from(deployment).where(eq(deployment.id, id));
		if (d && seen.at(-1) !== d.status) seen.push(d.status);
		if (d && isTerminal(d.status)) return Object.assign(d, { seen });
		if (Date.now() > deadline)
			throw new Error(`deployment ${id} stuck; saw ${seen.join(" -> ")}`);
		await Bun.sleep(250);
	}
}

/** Removes only objects whose name starts with PREFIX (and images built under it). */
export async function cleanup() {
	const ours = (n: string | undefined) =>
		!!n?.replace(/^\//, "").startsWith(PREFIX);
	const ignore = () => {};
	for (const s of await docker.services.list({ name: [PREFIX] }))
		if (ours(s.Spec.Name)) await docker.services.remove(s.ID).catch(ignore);
	for (let i = 0; i < 40; i++) {
		const left = (
			await docker.containers.list({ name: [PREFIX] }, true)
		).filter(
			(c) =>
				c.Names.some(ours) || ours(c.Labels["com.docker.swarm.service.name"]),
		);
		const tasks = left.filter((c) => c.Labels["com.docker.swarm.service.name"]);
		for (const c of left.filter(
			(c) => !c.Labels["com.docker.swarm.service.name"],
		))
			await docker.containers.remove(c.Id, true).catch(ignore);
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
	const images = sh("docker", "images", "--format", "{{.Repository}}:{{.Tag}}")
		.split("\n")
		.filter((r) => /^ls-local\/[^/]+\/ls-test-worker-/.test(r));
	for (const ref of images) await docker.images.remove(ref, true).catch(ignore);
}
