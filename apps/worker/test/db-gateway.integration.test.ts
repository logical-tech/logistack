// Real Swarm and a real Postgres 16 compiled with a certificate: the gateway's TLS and allowlist
// checks, a forward's expiry, and the per-org database network. Every object is
// `ls-test-dbgw-*` labelled `logistack.test=dbgw`. Opt in with DBOPS_IT=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CompileServiceInput,
	compileService,
	dockerName,
	orgDbNetworkName,
	serviceFiles,
} from "@logistack/core";
import { createDb } from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { ensureOrgDbNetwork } from "../src/apply.ts";
import type { Ctx } from "../src/ctx.ts";
import { startGateway } from "../src/db-gateway.ts";
import { hasDocker, sh } from "./harness.ts";

const P = "ls-test-dbgw-";
const LABEL = { "logistack.test": "dbgw" };
const enabled = hasDocker && process.env.DBOPS_IT === "1";
const SERVICE = "svc_dbgw0000000000000000000000";
const ORG_A = "dbgwOrgAlpha";
const ORG_B = "dbgwOrgBravo";
const HOST_PORT = 25433;
const PASSWORD = "gw-test-password";
const docker = createDockerClient();
const dir = mkdtempSync(join(tmpdir(), P));
const quiet = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" });

// Only what ensureOrgDbNetwork reads; no stack api here, so nothing gets attached.
const ctx = {
	docker,
	cfg: {
		LS_NAME_PREFIX: P,
		LS_SCOPE_LABELS: LABEL,
		LS_STACK_NAME: `${P}nostack`,
	},
} as unknown as Ctx;

let certPem = "";
let orgB = "";

async function cleanup() {
	for (const s of await docker.services.list({ name: [P] }))
		if (s.Spec.Name.startsWith(P)) await docker.services.remove(s.ID);
	for (const s of await docker.secrets.list({ name: [P] }))
		if (s.Spec.Name.startsWith(P))
			await docker.secrets.remove(s.ID).catch(() => {});
	for (let i = 0; i < 120; i++) {
		const nets = (await docker.networks.list({ name: [P] })).filter((n) =>
			n.Name.startsWith(P),
		);
		for (const n of nets) await docker.networks.remove(n.Id).catch(() => {});
		const vol = `${P}${dockerName("vol", SERVICE)}`;
		const volGone =
			quiet("docker", "volume", "rm", vol).exitCode === 0 ||
			quiet("docker", "volume", "inspect", vol).exitCode !== 0;
		if (!nets.length && volGone) break;
		await Bun.sleep(500);
	}
	for (const s of await docker.secrets.list({ name: [P] }))
		if (s.Spec.Name.startsWith(P))
			await docker.secrets.remove(s.ID).catch(() => {});
}

const connect = (port: number, ssl: unknown) =>
	createDb(`postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`, {
		ssl: ssl as never,
		connect_timeout: 5,
		max: 1,
		onnotice: () => {},
	}).$client;

/** Whether a query over `ssl` succeeds, and over TLS. */
async function probe(port: number, ssl: unknown) {
	const sql = connect(port, ssl);
	try {
		const [row] = await sql<{ ssl: boolean }[]>`
			select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
		return { ok: true as const, tls: row?.ssl === true };
	} catch (e) {
		return { ok: false as const, error: String(e) };
	} finally {
		await sql.end({ timeout: 1 }).catch(() => {});
	}
}

const verified = () => ({ ca: certPem, servername: "db.test" });

/**
 * Sends a plain (no SSLRequest) Postgres startup packet and reports whether anything answered
 * before the socket closed. A client library would retry a dropped connection forever.
 */
async function plainStartup(port: number): Promise<"answered" | "closed"> {
	const params = "user\0postgres\0database\0postgres\0\0";
	const packet = Buffer.alloc(8 + params.length);
	packet.writeInt32BE(packet.length, 0);
	packet.writeInt32BE(196608, 4); // protocol 3.0
	packet.write(params, 8, "latin1");
	return new Promise((resolve) => {
		let answered = false;
		Bun.connect({
			hostname: "127.0.0.1",
			port,
			socket: {
				open: (s) => void s.write(packet),
				data: (s) => {
					answered = true;
					s.end();
				},
				close: () => resolve(answered ? "answered" : "closed"),
				error: () => resolve(answered ? "answered" : "closed"),
			},
		}).catch(() => resolve("closed"));
	});
}

describe.skipIf(!enabled)("database gateway and org network", () => {
	beforeAll(async () => {
		await cleanup();
		const key = join(dir, "key.pem");
		const crt = join(dir, "cert.pem");
		sh(
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=db.test",
			"-addext",
			"subjectAltName=DNS:db.test",
			"-keyout",
			key,
			"-out",
			crt,
		);
		certPem = readFileSync(crt, "utf8");
		await ensureOrgDbNetwork(ctx, ORG_A);
		orgB = await ensureOrgDbNetwork(ctx, ORG_B);
		const env = sh(
			"docker",
			"network",
			"create",
			"--driver",
			"overlay",
			"--attachable",
			"--label",
			"logistack.test=dbgw",
			`${P}env`,
		);
		const input: CompileServiceInput = {
			service: {
				id: SERVICE,
				organizationId: ORG_B,
				environmentId: "env_dbgw00000000000000000000",
				slug: "orders-db",
				desiredState: "running",
				spec: {
					kind: "database",
					engine: "postgres",
					version: "16",
					credentialsRef: "test",
					resources: {},
				},
			},
			deploymentId: "dep_dbgw",
			env: { POSTGRES_PASSWORD: PASSWORD },
			context: {
				project: "DBGW",
				environment: "test",
				service: "orders-db",
				domains: [],
			},
			mounts: [],
			domains: [],
			networks: { environment: env, ingress: env, db: orgB },
			pinNodeId: sh("docker", "info", "-f", "{{.Swarm.NodeID}}"),
			tls: { certPem, keyPem: readFileSync(key, "utf8") },
			fileIds: {},
			scope: { namePrefix: P, labels: LABEL },
		};
		for (const f of serviceFiles(input)) {
			const { ID } = await docker.secrets.create({
				Name: f.name,
				Labels: f.labels,
				Data: f.data,
			});
			input.fileIds[f.name] = ID;
		}
		const spec = compileService(input);
		// The test reaches the database from the host; production reaches it only on overlays.
		spec.EndpointSpec = {
			Mode: "vip",
			Ports: [
				{
					Protocol: "tcp",
					TargetPort: 5432,
					PublishedPort: HOST_PORT,
					PublishMode: "host",
				},
			],
		};
		await docker.services.create(spec);
		const deadline = Date.now() + 180_000;
		for (;;) {
			const r = await probe(HOST_PORT, false);
			if (r.ok) break;
			if (Date.now() > deadline) throw new Error(`postgres not up: ${r.error}`);
			await Bun.sleep(1000);
		}
	}, 240_000);

	afterAll(async () => {
		if (!enabled) return;
		await cleanup();
		rmSync(dir, { recursive: true, force: true });
	}, 120_000);

	test("the database serves TLS beside plain, so internal clients are unchanged", async () => {
		expect(await probe(HOST_PORT, false)).toEqual({ ok: true, tls: false });
		expect(await plainStartup(HOST_PORT)).toBe("answered");
		expect(await probe(HOST_PORT, verified())).toEqual({ ok: true, tls: true });
	});

	test("through the gateway a plain connection is refused and TLS is accepted", async () => {
		const gw = await startGateway({
			port: 0,
			hostname: "127.0.0.1",
			upstream: { host: "127.0.0.1", port: HOST_PORT },
			mode: "postgres",
			allow: ["127.0.0.1/32"],
		});
		try {
			expect(await plainStartup(gw.port)).toBe("closed");
			// The certificate verifies against its name: this is what `sslmode=verify-full` checks.
			expect(await probe(gw.port, verified())).toEqual({ ok: true, tls: true });
		} finally {
			gw.stop();
		}
	}, 30_000);

	test("a source address outside the allowlist is refused", async () => {
		const gw = await startGateway({
			port: 0,
			hostname: "127.0.0.1",
			upstream: { host: "127.0.0.1", port: HOST_PORT },
			mode: "postgres",
			allow: ["192.0.2.0/24", "2001:db8::/32"],
		});
		try {
			expect((await probe(gw.port, verified())).ok).toBe(false);
		} finally {
			gw.stop();
		}
	}, 30_000);

	test("a port forward closes at its expiry, dropping open connections", async () => {
		const gw = await startGateway({
			port: 0,
			hostname: "127.0.0.1",
			upstream: { host: "127.0.0.1", port: HOST_PORT },
			mode: "postgres",
			allow: ["127.0.0.1"],
			expiresAt: new Date(Date.now() + 3000),
		});
		expect(await probe(gw.port, verified())).toEqual({ ok: true, tls: true });
		// A connection held open across the deadline: the SSLRequest gets Postgres's "S", then silence.
		let answer = "";
		const dropped = new Promise<void>((resolve) => {
			Bun.connect({
				hostname: "127.0.0.1",
				port: gw.port,
				socket: {
					open: (sock) =>
						void sock.write(new Uint8Array([0, 0, 0, 8, 4, 210, 22, 47])),
					data: (_s, d) => {
						answer += String.fromCharCode(...d);
					},
					close: () => resolve(),
				},
			});
		});
		await gw.closed;
		await dropped;
		expect(answer).toBe("S");
		const refused = await Bun.connect({
			hostname: "127.0.0.1",
			port: gw.port,
			socket: { data: () => {} },
		}).then(
			(sock) => {
				sock.end();
				return false;
			},
			() => true,
		);
		expect(refused).toBe(true);
	}, 30_000);

	test("a database of another organization is not reachable", async () => {
		const name = `${P}${dockerName("svc", SERVICE)}`;
		const ready = (net: string, host: string) =>
			quiet(
				"docker",
				"run",
				"--rm",
				"--label",
				"logistack.test=dbgw",
				"--network",
				net,
				"postgres:16",
				"pg_isready",
				"-h",
				host,
				"-t",
				"5",
			).exitCode === 0;
		const task = (await docker.tasks.list({ service: [name] })).find(
			(t) => t.Status.State === "running",
		);
		const attachments = JSON.parse(
			sh(
				"docker",
				"inspect",
				"-f",
				"{{json .NetworksAttachments}}",
				task?.ID ?? "",
			),
		) as { Network: { ID: string }; Addresses: string[] }[];
		const ip = attachments
			.find((a) => a.Network.ID === orgB)
			?.Addresses[0]?.split("/")[0];
		expect(ip).toBeTruthy();
		const netA = orgDbNetworkName(ORG_A, P);
		const netB = orgDbNetworkName(ORG_B, P);
		expect(ready(netB, name)).toBe(true);
		expect(ready(netA, name)).toBe(false);
		expect(ready(netA, ip as string)).toBe(false);
	}, 60_000);
});
