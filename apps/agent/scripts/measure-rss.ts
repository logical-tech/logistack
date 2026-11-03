// Soak: the compiled agent image on Linux (in a container) against the real daemon, ~10 busy
// containers, a gateway on this host, one log follow open throughout and an exec per sample.
// RSS is the kernel's VmRSS for the agent process, read from outside every 30 s.
//   docker build -f install/agent.Dockerfile -t ls-test-agent-image:rss .
//   bun apps/agent/scripts/measure-rss.ts            # RSS_MINUTES=6 by default
import { createDockerClient } from "@logistack/docker";
import { RedisClient } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import {
	METRICS_STREAM,
	mountAgentGateway,
	staticTokenAuth,
} from "../../server/src/agent-gateway.ts";
import { setLogLevel } from "../../server/src/log.ts";

const IMAGE = process.env.AGENT_IMAGE ?? "ls-test-agent-image:rss";
const MINUTES = Number(process.env.RSS_MINUTES ?? 6);
const PREFIX = `ls-test-agent-rss-${Date.now().toString(36)}`;
const LABELS = { "logistack.test": "agent" };
const TOKEN = "lsn_rss";
const docker = createDockerClient();

const sh = (...argv: string[]) => {
	const p = Bun.spawnSync(argv, { stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${p.stderr}`);
	return p.stdout.toString().trim();
};

async function run(name: string, req: Record<string, unknown>) {
	const { Id } = await docker.containers.create(name, {
		Labels: LABELS,
		...req,
	} as never);
	await docker.containers.start(Id);
	return Id;
}

async function cleanup() {
	for (const s of await docker.services.list({ name: [PREFIX] }))
		if (s.Spec.Name.startsWith(PREFIX)) await docker.services.remove(s.ID);
	await Bun.sleep(5000);
	for (const c of await docker.containers.list({ name: [PREFIX] }, true))
		if (c.Names.some((n) => n.startsWith(`/${PREFIX}`)))
			await docker.containers.remove(c.Id, true).catch(() => {});
}

setLogLevel("silent");
try {
	await run(`${PREFIX}-redis`, {
		Image: "redis:7-alpine",
		HostConfig: {
			PortBindings: { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
		},
	});
	const redisPort = sh("docker", "port", `${PREFIX}-redis`, "6379/tcp")
		.split("\n")[0]
		?.split(":")
		.at(-1);
	const redis = new RedisClient(`redis://127.0.0.1:${redisPort}`);
	for (
		let i = 0;
		i < 50 && (await redis.ping().catch(() => "")) !== "PONG";
		i++
	)
		await Bun.sleep(100);

	const events: string[] = [];
	const app = new Hono();
	const agents = mountAgentGateway(app, {
		bus: { publishEvent: async (e) => void events.push(e.type) },
		redis,
		authenticate: staticTokenAuth(TOKEN, "org_rss"),
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: app.fetch,
		websocket,
	});

	const svc = await docker.services.create({
		Name: `${PREFIX}-svc`,
		Labels: LABELS,
		TaskTemplate: {
			ContainerSpec: {
				Image: "busybox:1.37",
				Labels: { ...LABELS, "logistack.managed": "true" },
				Command: [
					"sh",
					"-c",
					"while true; do echo line $RANDOM; head -c 20000 /dev/urandom | md5sum >/dev/null; sleep 1; done",
				],
			},
		},
		Mode: { Replicated: { Replicas: 10 } },
	});
	const running = async () =>
		(await docker.tasks.list({ service: [svc.ID] })).filter(
			(t) => t.Status.State === "running",
		);
	for (let i = 0; i < 600 && (await running()).length < 10; i++)
		await Bun.sleep(100);

	const nodeId = (await docker.info()).Swarm.NodeID || "local";
	const agentId = await run(`${PREFIX}-agent`, {
		Image: IMAGE,
		Env: [
			`LOGISTACK_API_URL=http://host.docker.internal:${server.port}`,
			`LOGISTACK_AGENT_TOKEN=${TOKEN}`,
			`LOGISTACK_NODE_ID=${nodeId}`,
			"LOGISTACK_NODE_HOSTNAME=rss-node",
			"HOST_PROC=/host/proc",
			"HOST_SYS=/host/sys",
			"HOST_ROOT=/host/root",
		],
		HostConfig: {
			Binds: [
				"/var/run/docker.sock:/var/run/docker.sock",
				"/proc:/host/proc:ro",
				"/sys:/host/sys:ro",
				"/:/host/root:ro",
			],
		},
	});
	for (let i = 0; i < 100 && !agents.connected().length; i++)
		await Bun.sleep(100);
	if (!agents.connected().length)
		throw new Error(`agent did not connect: ${sh("docker", "logs", agentId)}`);

	let logLines = 0;
	const taskId = (await running())[0]?.ID as string;
	const follow = (async () => {
		for await (const _ of agents.followLogs(nodeId, {
			target: { kind: "task", taskId },
		}))
			logLines++;
	})().catch((e) => console.log("follow ended:", String(e)));
	let execs = 0;

	const start = Date.now();
	console.log("t_s\trss_mb\tmetrics\tevents\tcontainers");
	for (;;) {
		const pid = sh("docker", "inspect", "-f", "{{.State.Pid}}", agentId);
		// VmRSS in kB from the host PID namespace; `docker top` rounds to whole MB on OrbStack.
		const rssKb = Number(
			sh(
				"docker",
				"run",
				"--rm",
				"--pid=host",
				"--label",
				"logistack.test=agent",
				"--name",
				`${PREFIX}-probe`,
				"busybox:1.37",
				"grep",
				"VmRSS",
				`/proc/${pid}/status`,
			).match(/(\d+)\s*kB/)?.[1],
		);
		const metrics = Number(await redis.send("XLEN", [METRICS_STREAM]));
		const dockerEvents = Number(await redis.send("XLEN", ["ls:docker-events"]));
		const last = (await redis.send("XREVRANGE", [
			METRICS_STREAM,
			"+",
			"-",
			"COUNT",
			"1",
		])) as [string, string[]][];
		const fields = last[0]?.[1] ?? [];
		const m = fields.length
			? JSON.parse(fields[fields.indexOf("data") + 1] as string)
			: undefined;
		const t = Math.round((Date.now() - start) / 1000);
		console.log(
			`${t}\t${(rssKb / 1024).toFixed(1)}\t${metrics}\t${dockerEvents}\t${m?.containers.length ?? 0}`,
		);
		if (t >= MINUTES * 60) {
			console.log("host sample:", JSON.stringify(m?.host));
			console.log("node events:", events.join(","), "log lines:", logLines);
			break;
		}
		await Bun.sleep(30_000);
		for await (const e of agents.exec(nodeId, {
			target: { kind: "service", serviceId: svc.ID },
			cmd: ["true"],
			stdin: false,
		}))
			if (e.type === "exit" && e.code === 0) execs++;
		// Kill one replica a round so Swarm reschedules it and the event stream carries traffic.
		const victim = (await running()).at(-1)?.Status.ContainerStatus
			?.ContainerID;
		if (victim && (await running()).at(-1)?.ID !== taskId)
			sh("docker", "kill", victim);
	}
	console.log("execs ok:", execs);
	void follow;
	server.stop(true);
	redis.close();
} finally {
	await cleanup();
}
