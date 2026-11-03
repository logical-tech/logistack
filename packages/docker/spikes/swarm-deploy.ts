// Spike: Swarm start-first deploys under load, and automatic rollback on a failing healthcheck.
// Run: bun packages/docker/spikes/swarm-deploy.ts   (creates ls-test-deploy-*, removes it at the end)
import {
	createDockerClient,
	type DockerEvent,
	type ServiceSpec,
} from "../src/index.ts";

const docker = createDockerClient();
const PORT = Number(process.env.SPIKE_PORT ?? 18473);
const GOOD_UPDATES = Number(process.env.SPIKE_UPDATES ?? 3);
const CONCURRENCY = Number(process.env.SPIKE_CONCURRENCY ?? 1);
// stop-first is the control: the load loop must see failures there, or it measures nothing.
const ORDER =
	process.env.SPIKE_ORDER === "stop-first" ? "stop-first" : "start-first";
const s = (n: number) => n * 1e9;
const name = `ls-test-deploy-${Date.now().toString(36)}`;
const labels = { "logistack.test": "true" };

const spec = (version: number, healthPath = "/"): ServiceSpec => ({
	Name: name,
	Labels: labels,
	TaskTemplate: {
		ContainerSpec: {
			Image: "busybox:1.37",
			Labels: labels,
			Command: ["sh", "-c"],
			Args: [
				`mkdir -p /www && echo v=${version} > /www/index.html && exec httpd -f -p 8080 -h /www`,
			],
			Healthcheck: {
				Test: [
					"CMD",
					"wget",
					"-q",
					"-O",
					"/dev/null",
					`http://127.0.0.1:8080${healthPath}`,
				],
				Interval: s(1),
				Timeout: s(1),
				Retries: 2,
				StartPeriod: s(2),
			},
			StopGracePeriod: s(2),
		},
		RestartPolicy: { Condition: "any", Delay: s(1), MaxAttempts: 3 },
	},
	Mode: { Replicated: { Replicas: 1 } },
	UpdateConfig: {
		Parallelism: 1,
		Order: ORDER,
		FailureAction: "rollback",
		Monitor: s(5),
		MaxFailureRatio: 0,
	},
	RollbackConfig: {
		Parallelism: 1,
		Order: "start-first",
		Monitor: s(5),
		FailureAction: "pause",
	},
	EndpointSpec: {
		Ports: [
			{
				TargetPort: 8080,
				PublishedPort: PORT,
				Protocol: "tcp",
				PublishMode: "ingress",
			},
		],
	},
});

const stats = {
	ok: 0,
	failed: 0,
	versions: new Map<string, number>(),
	errors: new Map<string, number>(),
};
let loadOn = false;
async function load() {
	while (loadOn) {
		try {
			// Fresh connection per request so the ingress load balancer re-picks a task each time.
			const r = await fetch(`http://127.0.0.1:${PORT}/`, {
				headers: { connection: "close" },
				signal: AbortSignal.timeout(2000),
			});
			const body = (await r.text()).trim();
			if (r.ok) {
				stats.ok++;
				stats.versions.set(body, (stats.versions.get(body) ?? 0) + 1);
			} else {
				stats.failed++;
				stats.errors.set(
					`HTTP ${r.status}`,
					(stats.errors.get(`HTTP ${r.status}`) ?? 0) + 1,
				);
			}
		} catch (e) {
			stats.failed++;
			const k = (e as Error).name;
			stats.errors.set(k, (stats.errors.get(k) ?? 0) + 1);
		}
		await Bun.sleep(10);
	}
}

const reset = () => {
	stats.ok = 0;
	stats.failed = 0;
	stats.versions.clear();
	stats.errors.clear();
};
const report = () => ({
	ok: stats.ok,
	failed: stats.failed,
	versions: Object.fromEntries(stats.versions),
	errors: Object.fromEntries(stats.errors),
});

async function untilState(id: string, states: string[], timeoutMs = 120_000) {
	const t0 = Date.now();
	const seen: string[] = [];
	for (;;) {
		const svc = await docker.services.inspect(id);
		const st = svc.UpdateStatus?.State ?? "none";
		if (seen.at(-1) !== st) seen.push(st);
		if (states.includes(st)) return { svc, seen, ms: Date.now() - t0 };
		if (Date.now() - t0 > timeoutMs)
			throw new Error(`timeout; states seen ${seen.join(" -> ")}`);
		await Bun.sleep(200);
	}
}

async function update(id: string, next: ServiceSpec) {
	const cur = await docker.services.inspect(id);
	await docker.services.update(id, cur.Version.Index, next);
}

const ac = new AbortController();
const events: DockerEvent[] = [];
const watching = (async () => {
	try {
		for await (const e of docker.events({
			filters: { type: ["service"], service: [name] },
			signal: ac.signal,
		}))
			events.push(e);
	} catch (e) {
		if ((e as Error).name !== "AbortError") throw e;
	}
})();

let id = "";
try {
	({ ID: id } = await docker.services.create(spec(1)));
	const t0 = Date.now();
	for (;;) {
		const r = await fetch(`http://127.0.0.1:${PORT}/`).catch(() => null);
		if (r?.ok) break;
		await Bun.sleep(200);
	}
	console.log(`service ${name} serving after ${Date.now() - t0}ms`);

	loadOn = true;
	const loader = Promise.all(Array.from({ length: CONCURRENCY }, load));
	await Bun.sleep(2000);
	console.log(`baseline 2s, ${CONCURRENCY} client(s)`, report());

	for (let v = 2; v < 2 + GOOD_UPDATES; v++) {
		reset();
		await update(id, spec(v));
		const r = await untilState(id, [
			"completed",
			"rollback_completed",
			"paused",
		]);
		await Bun.sleep(1000);
		console.log(
			`good update -> v=${v}: ${r.seen.join(" -> ")} in ${r.ms}ms`,
			report(),
		);
	}

	reset();
	const lastGood = 1 + GOOD_UPDATES;
	await update(id, spec(99, "/healthz-missing"));
	const r = await untilState(
		id,
		["rollback_completed", "rollback_paused", "paused", "completed"],
		180_000,
	);
	await Bun.sleep(1000);
	console.log(
		`bad update -> v=99: ${r.seen.join(" -> ")} in ${r.ms}ms`,
		report(),
	);
	console.log("UpdateStatus", r.svc.UpdateStatus);
	console.log(
		"Spec is back to",
		r.svc.Spec.TaskTemplate.ContainerSpec.Args?.[0]?.match(/v=\d+/)?.[0],
		"expected",
		`v=${lastGood}`,
	);

	loadOn = false;
	await loader;
	const tasks = await docker.tasks.list({ service: [id] });
	console.log(
		"tasks",
		tasks.map(
			(t) =>
				`${t.Spec.ContainerSpec.Args?.[0]?.match(/v=\d+/)?.[0]} ${t.Status.State} ${t.Status.Err ?? t.Status.Message}`,
		),
	);
} finally {
	loadOn = false;
	if (id) await docker.services.remove(id);
	await Bun.sleep(500);
	ac.abort();
	await watching;
	console.log(
		"service events",
		events.map((e) => {
			const a = e.Actor.Attributes;
			return `${e.Action}${a["updatestate.new"] ? ` ${a["updatestate.old"] ?? ""}->${a["updatestate.new"]}` : ""}`;
		}),
	);
	console.log("removed", name);
}
