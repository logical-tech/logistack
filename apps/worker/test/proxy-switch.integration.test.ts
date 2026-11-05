// Real Swarm, Postgres and Redis: the proxy switch with a fake Traefik container and a fake Caddy,
// both on one host port, exactly as they compete for 80/443 on a Dokploy server. The ingress label
// and every name are test-only (`ls-test-mig4-*`). Opt in with WORKER_IT=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	domain,
	environment,
	migration,
	migrationItem,
	organization,
	project,
	service,
} from "@logistack/db";
import { CADDY_PREFIX } from "../src/certs.ts";
import { type RunningWorker, startWorker } from "../src/index.ts";
import { switchProxy } from "../src/proxy-switch.ts";
import { cleanup, hasDocker, sh, startInfra, workerConfig } from "./harness.ts";

const enabled = hasDocker && process.env.WORKER_IT === "1";

const T = "ls-test-mig4-";
const TRAEFIK = `${T}traefik`;
const CADDY = `${T}caddy`;
const LABEL = "logistack.test-mig4-ingress";
const HOST = "app.example.test";
const PORT = 20000 + Math.floor(Math.random() * 20000);

const quiet = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" });
const node = () => sh("docker", "info", "--format", "{{.Swarm.NodeID}}");
const nodeLabel = () =>
	sh(
		"docker",
		"node",
		"inspect",
		node(),
		"--format",
		`{{index .Spec.Labels "${LABEL}"}}`,
	);
const setLabel = (v: string) =>
	sh("docker", "node", "update", "--label-add", `${LABEL}=${v}`, node());
const traefik = (field: string) =>
	sh("docker", "inspect", TRAEFIK, "--format", field);

function removeFakes() {
	quiet("docker", "service", "rm", CADDY);
	quiet("docker", "rm", "-f", TRAEFIK);
	// A removed service's host-mode task keeps the port until it has exited.
	for (let i = 0; i < 60; i++) {
		const left = Bun.spawnSync([
			"docker",
			"ps",
			"-aq",
			"--filter",
			`label=com.docker.swarm.service.name=${CADDY}`,
		]).stdout.toString();
		if (!left.trim()) break;
		Bun.sleepSync(500);
	}
	quiet("docker", "node", "update", "--label-rm", LABEL, node());
}

/** A Traefik stand-in: holds PORT, restarts always, keeps acme.json where Dokploy's does. */
function startTraefik() {
	sh(
		"docker",
		"run",
		"-d",
		"--name",
		TRAEFIK,
		"--label",
		"logistack.test=mig4",
		"--restart",
		"always",
		"-p",
		`${PORT}:8080`,
		"busybox:1.37",
		"sh",
		"-c",
		"mkdir -p /etc/dokploy/traefik/dynamic /www && echo traefik > /www/index.html && httpd -f -p 8080 -h /www",
	);
	for (let i = 0; i < 40; i++) {
		if (
			quiet(
				"docker",
				"exec",
				TRAEFIK,
				"test",
				"-d",
				"/etc/dokploy/traefik/dynamic",
			).exitCode === 0
		)
			break;
		Bun.sleepSync(250);
	}
	sh(
		"docker",
		"cp",
		`${import.meta.dir}/fixtures/acme.json`,
		`${TRAEFIK}:/etc/dokploy/traefik/dynamic/acme.json`,
	);
}

/** A Caddy stand-in: global on nodes labelled true, wanting the same host port. */
function createCaddy(command: string) {
	sh(
		"docker",
		"service",
		"create",
		"-q",
		"-d",
		"--name",
		CADDY,
		"--label",
		"logistack.test=mig4",
		"--mode",
		"global",
		"--constraint",
		`node.labels.${LABEL} == true`,
		"--publish",
		`mode=host,published=${PORT},target=8080`,
		"busybox:1.37",
		"sh",
		"-c",
		command,
	);
}

describe.skipIf(!enabled)("proxy switch on the real Swarm", () => {
	let w: RunningWorker;
	let orgId: string;
	let serviceId: string;
	const ctx = () => w.ctx;
	const db = () => w.ctx.db;

	async function cutOverMigration() {
		const [m] = await db()
			.insert(migration)
			.values({ organizationId: orgId, source: "dokploy", status: "imported" })
			.returning();
		await db()
			.insert(migrationItem)
			.values({
				migrationId: m?.id as string,
				kind: "application",
				sourceId: "web",
				name: "web",
				position: 0,
				status: "cut_over",
				planEncrypted: "unused",
				targets: { web: serviceId },
			});
		return m?.id as string;
	}

	beforeAll(async () => {
		await cleanup();
		removeFakes();
		sh("docker", "pull", "-q", "busybox:1.37");
		const cfg = await workerConfig(await startInfra());
		cfg.LS_INGRESS_LABEL = LABEL;
		cfg.LS_CADDY_SERVICE = CADDY;
		cfg.LS_DOKPLOY_TRAEFIK = TRAEFIK;
		cfg.LS_PROXY_SWITCH_TIMEOUT_MS = 20_000;
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
		serviceId = s?.id as string;
		await db().insert(domain).values({ serviceId, hostname: HOST, port: 80 });
	}, 180_000);

	afterAll(async () => {
		await w?.stop();
		await cleanup();
		removeFakes();
	}, 120_000);

	test("Traefik stops for good, Caddy takes the port, the certificate is imported", async () => {
		setLabel("pending");
		startTraefik();
		createCaddy(
			"mkdir -p /www && echo caddy > /www/index.html && httpd -f -p 8080 -h /www",
		);
		const migrationId = await cutOverMigration();
		const state = await switchProxy(ctx(), migrationId, async (hostname) => {
			// Stands in for DNS: the migrated hostname lands on this node's port.
			const body = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
			return {
				ok: body.trim() === "caddy",
				detail: `${hostname}: ${body.trim()}`,
			};
		});
		expect(state.result).toMatchObject({
			status: "switched",
			probes: [{ hostname: HOST, ok: true, detail: `${HOST}: caddy` }],
		});
		expect(state.certificates).toMatchObject({ imported: [HOST] });
		expect(state.traefik).toMatchObject({
			kind: "container",
			restartPolicy: "always",
			running: true,
		});
		expect(nodeLabel()).toBe("true");
		expect(traefik("{{.State.Status}}")).toBe("exited");
		// A reboot must not bring Traefik back onto the port.
		expect(traefik("{{.HostConfig.RestartPolicy.Name}}")).toBe("no");
		const crt = await ctx().bus.redis.exists(
			`${CADDY_PREFIX}/certificates/acme-v02.api.letsencrypt.org-directory/${HOST}/${HOST}.crt`,
		);
		expect(crt).toBe(true);
		// Done once: a second run changes nothing.
		expect((await switchProxy(ctx(), migrationId)).result?.status).toBe(
			"switched",
		);
	}, 180_000);

	test("a Caddy that never starts gives the port back to Traefik as it was", async () => {
		removeFakes();
		setLabel("pending");
		startTraefik();
		createCaddy("exit 1");
		const migrationId = await cutOverMigration();
		const state = await switchProxy(ctx(), migrationId);
		expect(state.result).toMatchObject({ status: "fell_back" });
		expect(nodeLabel()).toBe("pending");
		expect(traefik("{{.State.Status}}")).toBe("running");
		expect(traefik("{{.HostConfig.RestartPolicy.Name}}")).toBe("always");
		expect(
			(await (await fetch(`http://127.0.0.1:${PORT}/`)).text()).trim(),
		).toBe("traefik");
	}, 180_000);
});
