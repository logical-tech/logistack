import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { compileProxy } from "@logistack/proxy";
import { RedisClient } from "bun";
import { planAcmeImport, storeInCaddy } from "../src/acme-import.ts";
import { CADDY_PREFIX, readCaddyCerts } from "../src/certs.ts";

/** 32 characters, as the storage module takes it; production derives it from the master key. */
const STORAGE_KEY = "0123456789abcdef0123456789abcdef";

/** Every object here is named `ls-test-mig4-*` and labelled `logistack.test=mig4`; cleanup removes exactly these. */
const P = "ls-test-mig4-";
const NET = `${P}net`;
const REDIS = `${P}redis`;
const CADDY = `${P}caddy`;
const LABEL = "logistack.test=mig4";
/** The repo's Caddy build (docker/caddy), with the Redis storage module. */
const IMAGE = process.env.LS_TEST_CADDY_IMAGE ?? "ls-test-dns-caddy:dev";
const HOST = "app.example.test";

const run = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
const sh = (...argv: string[]) => {
	const p = run(...argv);
	if (p.exitCode !== 0)
		throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
};
const hasImage = run("docker", "image", "inspect", IMAGE).exitCode === 0;

function cleanup() {
	run("docker", "rm", "-f", "-v", CADDY, REDIS);
	run("docker", "network", "rm", NET);
}

/** Serial of the certificate Caddy presents for `servername`, lowercase hex. */
const servedSerial = (ip: string, servername: string) =>
	new Promise<string>((resolve, reject) => {
		const s = connect(
			{ host: ip, port: 443, servername, rejectUnauthorized: false },
			() => {
				resolve(s.getPeerCertificate().serialNumber.toLowerCase());
				s.end();
			},
		);
		s.on("error", reject);
	});

describe.skipIf(!hasImage)(
	"certificates imported from acme.json, served by real Caddy",
	() => {
		let redis: RedisClient;
		let dir = "";
		let caddyIp = "";
		const raw = Bun.file(`${import.meta.dir}/fixtures/acme.json`).text();

		beforeAll(async () => {
			cleanup();
			sh("docker", "network", "create", "--label", LABEL, NET);
			sh(
				"docker",
				"run",
				"-d",
				"--name",
				REDIS,
				"--label",
				LABEL,
				"--network",
				NET,
				"-p",
				"127.0.0.1::6379",
				"redis:7-alpine",
			);
			redis = new RedisClient(
				`redis://${sh("docker", "port", REDIS, "6379/tcp").split("\n")[0]}`,
			);
			for (let i = 0; ; i++) {
				try {
					await redis.send("PING", []);
					break;
				} catch (e) {
					if (i > 50) throw e;
					await Bun.sleep(200);
				}
			}
		}, 60_000);

		afterAll(() => {
			redis?.close();
			cleanup();
			if (dir) rmSync(dir, { recursive: true, force: true });
		});

		test("an import is written once; a re-run leaves Caddy's copy alone", async () => {
			const plan = planAcmeImport(await raw, [HOST], new Date());
			expect(await storeInCaddy(redis, plan)).toEqual([HOST]);
			expect(await storeInCaddy(redis, plan)).toEqual([]);
			expect(
				await redis.send("ZRANGE", [`${CADDY_PREFIX}/certificates`, "0", "-1"]),
			).toEqual(["acme-v02.api.letsencrypt.org-directory/"]);
		});

		test("Caddy serves the imported certificate from its first second, without asking the CA", async () => {
			const plan = planAcmeImport(await raw, [HOST], new Date());
			// Stored encrypted this time: Caddy must read the module's format as the worker writes it.
			await redis.send("FLUSHALL", []);
			expect(
				await storeInCaddy(redis, plan, new Date(), CADDY_PREFIX, STORAGE_KEY),
			).toEqual([HOST]);
			const stored = JSON.parse(
				(await redis.get(
					`${CADDY_PREFIX}/${plan.imports[0]?.files.at(-1)?.key}`,
				)) ?? "{}",
			);
			expect(stored.encryption).toBe(1);
			expect(atob(stored.value)).not.toContain("BEGIN");
			expect(
				(await readCaddyCerts(redis, CADDY_PREFIX, STORAGE_KEY)).map(
					(c) => c.names,
				),
			).toEqual([[HOST]]);
			const config = compileProxy({
				settings: {
					adminListen: "localhost:2019",
					acmeEmail: "ops@example.test",
					storage: {
						redisUrl: `redis://${REDIS}:6379`,
						keyPrefix: CADDY_PREFIX,
						encryptionKey: STORAGE_KEY,
					},
				},
				dashboard: { hostname: HOST, upstream: { host: "127.0.0.1", port: 9 } },
				routes: [],
			});
			dir = mkdtempSync(join(tmpdir(), `${P}cfg-`));
			writeFileSync(join(dir, "caddy.json"), JSON.stringify(config));
			sh(
				"docker",
				"run",
				"-d",
				"--name",
				CADDY,
				"--label",
				LABEL,
				"--network",
				NET,
				// Let's Encrypt is unreachable: a certificate Caddy shows can only come from storage.
				"--add-host",
				"acme-v02.api.letsencrypt.org:127.0.0.1",
				"-v",
				`${dir}/caddy.json:/etc/caddy/caddy.json:ro`,
				"--entrypoint",
				"caddy",
				IMAGE,
				"run",
				"--config",
				"/etc/caddy/caddy.json",
			);
			caddyIp = sh(
				"docker",
				"inspect",
				"-f",
				`{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`,
				CADDY,
			);
			let serial = "";
			const end = Date.now() + 20_000;
			while (!serial) {
				serial = await servedSerial(caddyIp, HOST).catch(() => "");
				if (!serial && Date.now() > end)
					throw new Error(
						`Caddy never served TLS: ${sh("docker", "logs", CADDY)}`,
					);
				if (!serial) await Bun.sleep(200);
			}
			expect(serial).toBe(plan.imports[0]?.serial as string);
			const logs = run("docker", "logs", CADDY).stderr.toString();
			expect(logs).toContain(HOST);
			expect(logs).not.toContain("obtaining certificate");
		}, 60_000);
	},
);
