import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDockerClient, type ServiceSpec } from "@logistack/docker";
import { Worker } from "bullmq";
import { loadConfig } from "../src/config.ts";
import { drain, resume } from "../src/drain.ts";
import { migrate } from "../src/instance-update.ts";
import { createQueues, redisConnection } from "../src/queues.ts";
import { runUpdate, type UpdateDocker } from "../src/update.ts";
import { hasDocker } from "./harness.ts";

/**
 * The update sequence against the real Swarm, with a fake api: a busybox httpd image in four
 * builds. v2 is a good release, v3 never passes its health check, v4 carries a migration that
 * fails. Every object is named `ls-test-pupd-*` and labelled logistack.test=pupd.
 */
const PREFIX = "ls-test-pupd-";
const STACK = `${PREFIX}stack`;
const SERVICE = `${STACK}_logistack-api`;
const IMAGE = `localhost/${PREFIX}app`;
const LABELS = { "logistack.test": "pupd" };
const docker = createDockerClient();
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6380";
const connection = redisConnection(redisUrl);
const queues = createQueues(connection, `${PREFIX}${Date.now()}`);
const cfg = loadConfig({
	DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
	REDIS_URL: redisUrl,
	LOGISTACK_MASTER_KEY: "unused",
	LS_STACK_NAME: STACK,
	LS_NAME_PREFIX: PREFIX,
	LS_SCOPE_LABELS: JSON.stringify(LABELS),
	LS_UPDATE_TIMEOUT_MS: "60000",
});

// Runs `bun install/migrate.ts` the way the api image's entrypoint would, or serves HTTP.
const DOCKERFILE = `FROM busybox:1.36
ARG VERSION
ARG HEALTH
ARG MIGRATE
RUN mkdir /www && echo "$VERSION" > /www/index.html \\
 && if [ "$HEALTH" = ok ]; then touch /healthy; fi \\
 && printf '#!/bin/sh\\nif [ "$1" = bun ]; then echo "applying migrations"; [ "%s" = ok ] && exit 0; echo "relation already exists" >&2; exit 1; fi\\nexec httpd -f -p 8080 -h /www\\n' "$MIGRATE" > /run.sh \\
 && chmod +x /run.sh
HEALTHCHECK --interval=1s --timeout=1s --start-period=2s --retries=2 CMD test -f /healthy && wget -qO- http://127.0.0.1:8080/ >/dev/null
ENTRYPOINT ["/run.sh"]
`;
const BUILDS = {
	v1: { HEALTH: "ok", MIGRATE: "ok" },
	v2: { HEALTH: "ok", MIGRATE: "ok" },
	v3: { HEALTH: "no", MIGRATE: "ok" },
	v4: { HEALTH: "ok", MIGRATE: "no" },
} as const;

async function cleanup() {
	for (const s of await docker.services.list({
		label: ["logistack.test=pupd"],
	}))
		if (s.Spec.Name.startsWith(PREFIX)) await docker.services.remove(s.ID);
}

const spec = (tag: string): ServiceSpec => ({
	Name: SERVICE,
	Labels: LABELS,
	TaskTemplate: {
		ContainerSpec: { Image: `${IMAGE}:${tag}`, Labels: LABELS },
		RestartPolicy: { Condition: "any", Delay: 1e9 },
	},
	Mode: { Replicated: { Replicas: 1 } },
	// What install/stack.yml gives logistack-api.
	UpdateConfig: {
		Parallelism: 1,
		Order: "start-first",
		FailureAction: "rollback",
		Monitor: 5e9,
	},
	RollbackConfig: { Parallelism: 1, Order: "start-first" },
	EndpointSpec: { Ports: [{ TargetPort: 8080, Protocol: "tcp" }] },
});

/** Asks the published port every 100 ms until stopped; returns what failed. */
function probe(port: number) {
	let stop = false;
	const failures: string[] = [];
	let ok = 0;
	const done = (async () => {
		while (!stop) {
			try {
				const r = await fetch(`http://127.0.0.1:${port}/`, {
					signal: AbortSignal.timeout(1_000),
				});
				if (r.ok) ok++;
				else failures.push(`HTTP ${r.status}`);
			} catch (e) {
				failures.push(String(e));
			}
			await Bun.sleep(100);
		}
	})();
	return async () => {
		stop = true;
		await done;
		return { ok, failures };
	};
}

const imageOf = async () =>
	(await docker.services.inspect(SERVICE)).Spec.TaskTemplate.ContainerSpec
		.Image;

describe.skipIf(!hasDocker)("rolling update on Swarm", () => {
	let port = 0;
	beforeAll(async () => {
		await cleanup();
		for (const [tag, args] of Object.entries(BUILDS)) {
			const p = Bun.spawnSync(
				[
					"docker",
					"build",
					"-q",
					"-t",
					`${IMAGE}:${tag}`,
					"--label",
					"logistack.test=pupd",
					"--build-arg",
					`VERSION=${tag}`,
					"--build-arg",
					`HEALTH=${args.HEALTH}`,
					"--build-arg",
					`MIGRATE=${args.MIGRATE}`,
					"-",
				],
				{ stdin: new TextEncoder().encode(DOCKERFILE), stderr: "pipe" },
			);
			if (p.exitCode !== 0) throw new Error(p.stderr.toString());
		}
		await docker.services.create(spec("v1"));
		for (let i = 0; ; i++) {
			const svc = await docker.services.inspect(SERVICE);
			port = svc.Endpoint?.Ports?.[0]?.PublishedPort ?? 0;
			const r = port
				? await fetch(`http://127.0.0.1:${port}/`).catch(() => null)
				: null;
			if (r?.ok && (await r.text()).trim() === "v1") break;
			if (i > 120) throw new Error("v1 never served");
			await Bun.sleep(250);
		}
	}, 120_000);

	afterAll(async () => {
		await cleanup();
		for (const tag of Object.keys(BUILDS))
			Bun.spawnSync(["docker", "image", "rm", "-f", `${IMAGE}:${tag}`], {
				stdout: "ignore",
				stderr: "ignore",
			});
		for (const q of Object.values(queues)) {
			await q.obliterate({ force: true });
			await q.close();
		}
	});

	const lines: string[] = [];
	const steps: Record<string, string> = {};
	const report = {
		step: async (s: string, st: string) => {
			steps[s] = st;
		},
		line: async (t: string) => {
			lines.push(t);
		},
	};
	const updates: number[] = [];
	const watched: UpdateDocker = {
		...docker,
		services: {
			inspect: docker.services.inspect,
			update: (...a: Parameters<typeof docker.services.update>) => {
				updates.push(Date.now());
				return docker.services.update(...a);
			},
		},
	};
	const run = (tag: string) =>
		runUpdate(
			watched,
			[
				{
					step: "logistack-api",
					service: SERVICE,
					image: `${IMAGE}:${tag}`,
				},
			],
			report,
			{ local: true, timeoutMs: 90_000, pollMs: 500 },
			{
				drain: (r) => drain(queues, r, { timeoutMs: 30_000, pollMs: 200 }),
				resume: () => resume(queues),
				migrate: (image, r) =>
					migrate({ cfg }, docker, `upd_${tag}pupd`, image, r),
			},
		);

	test("waits for a running deployment, migrates, then replaces the api with no failed request", async () => {
		let finish = () => {};
		let finishedAt = 0;
		const held = new Promise<void>((r) => {
			finish = r;
		});
		const worker = new Worker(
			"deploy",
			async () => {
				await held;
				finishedAt = Date.now();
			},
			{ connection, prefix: queues.deploy.opts.prefix },
		);
		try {
			await queues.deploy.add("service", {});
			while (!(await queues.deploy.getActiveCount())) await Bun.sleep(50);
			setTimeout(finish, 2_000);
			const stop = probe(port);
			const result = await run("v2");
			const seen = await stop();
			expect(result).toEqual({ ok: true });
			expect(finishedAt).toBeGreaterThan(0);
			expect(updates[0]).toBeGreaterThan(finishedAt);
			expect(lines).toContain("Waiting for 1 deployment");
			expect(lines).toContain("Database migrated");
			expect(seen.failures).toEqual([]);
			expect(seen.ok).toBeGreaterThan(20);
			expect(await imageOf()).toStartWith(`${IMAGE}:v2`);
			expect(
				(await (await fetch(`http://127.0.0.1:${port}/`)).text()).trim(),
			).toBe("v2");
			const [job] = await docker.tasks.list({
				service: [`${PREFIX}ls-update-migrate-v2pupd`],
			});
			expect(job?.Status.State).toBe("complete");
			expect(await queues.deploy.isPaused()).toBe(false);
		} finally {
			finish();
			await worker.close();
		}
	}, 180_000);

	test("a release that never turns healthy rolls back while the old task keeps serving", async () => {
		updates.length = 0;
		const stop = probe(port);
		const result = await run("v3");
		const seen = await stop();
		expect(result.ok).toBe(false);
		expect(steps["logistack-api"]).toBe("failed");
		expect(await imageOf()).toStartWith(`${IMAGE}:v2`);
		expect(seen.failures).toEqual([]);
		expect(seen.ok).toBeGreaterThan(20);
		expect(await queues.deploy.isPaused()).toBe(false);
	}, 180_000);

	test("a failed migration stops the update before any service changes", async () => {
		updates.length = 0;
		const result = await run("v4");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain("relation already exists");
		expect(!result.ok && result.error).toContain("No service was changed.");
		expect(steps.migrate).toBe("failed");
		expect(updates).toEqual([]);
		expect(await imageOf()).toStartWith(`${IMAGE}:v2`);
		expect(await queues.deploy.isPaused()).toBe(false);
	}, 120_000);
});
