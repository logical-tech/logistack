import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decrypt } from "@logistack/core";
import { deployment, envVar, secret, secretVersion } from "@logistack/db";
import {
	recheckExternalSecrets,
	storedPlaceholder,
} from "@logistack/worker/external-secrets";
import { loadService } from "@logistack/worker/load";
import { eq, inArray } from "drizzle-orm";
import type { Ctx } from "../../worker/src/ctx.ts";
import { processService } from "../../worker/src/deploy.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const AREA = "secrets-ext";
const vaultName = `ls-test-${AREA}-${crypto.randomUUID().slice(0, 8)}-vault`;
const ROOT_TOKEN = `root-${crypto.randomUUID()}`;

function docker(argv: string[], env: Record<string, string> = {}) {
	const p = Bun.spawnSync(["docker", ...argv], {
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	if (p.exitCode !== 0)
		throw new Error(`docker ${argv[0]} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

/** A Vault dev server (KV v2 at `secret/`); the root token reaches it through env, not argv. */
async function startVault() {
	docker(
		[
			"run",
			"-d",
			"--name",
			vaultName,
			"--label",
			`logistack.test=${AREA}`,
			"-p",
			"127.0.0.1::8200",
			"-e",
			"VAULT_DEV_ROOT_TOKEN_ID",
			"-e",
			"SKIP_SETCAP=1",
			"hashicorp/vault:1.18",
		],
		{ VAULT_DEV_ROOT_TOKEN_ID: ROOT_TOKEN },
	);
	const url = `http://${docker(["port", vaultName, "8200/tcp"]).split("\n")[0]}`;
	const deadline = Date.now() + 60_000;
	for (;;) {
		const ok = await fetch(`${url}/v1/sys/health`)
			.then((r) => r.ok)
			.catch(() => false);
		if (ok) return url;
		if (Date.now() > deadline) throw new Error("vault did not start");
		await Bun.sleep(300);
	}
}

describe.skipIf(!hasDocker)("external secrets (Vault)", () => {
	let h: Harness;
	let vaultUrl: string;
	let cookie: string;
	let serviceId: string;
	const auth = () => ({ headers: { cookie } });
	const kv = (data: Record<string, string>) =>
		fetch(`${vaultUrl}/v1/secret/data/app/db`, {
			method: "POST",
			headers: { "x-vault-token": ROOT_TOKEN },
			body: JSON.stringify({ data }),
		}).then((r) => expect(r.ok).toBe(true));

	beforeAll(async () => {
		vaultUrl = await startVault();
		await kv({ password: "pw-one", user: "app" });
		h = await startHarness({ area: AREA, label: AREA });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		// Vault listens on loopback over http: allowed only once private hosts are.
		expect(
			(
				await h.call("PATCH", "/api/instance/settings", {
					...auth(),
					body: { allowPrivateHosts: true },
				})
			).status,
		).toBe(200);
		const projectId = (
			await h.call("POST", "/api/projects", {
				...auth(),
				body: { name: "Shop" },
			})
		).json.id;
		const environmentId = (
			await h.call("GET", `/api/projects/${projectId}/environments`, auth())
		).json[0].id;
		serviceId = (
			await h.call("POST", `/api/environments/${environmentId}/services`, {
				...auth(),
				body: {
					name: "Web",
					spec: {
						kind: "application",
						source: { type: "image", image: "nginx:1.27" },
						build: { type: "image" },
						ports: [{ target: 80, protocol: "tcp" }],
						replicas: 1,
						resources: { memoryMb: 256 },
						placement: [],
					},
				},
			})
		).json.id;
	}, 120_000);

	afterAll(async () => {
		await h?.close();
		Bun.spawnSync(["docker", "rm", "-f", "-v", vaultName], {
			stdout: "ignore",
			stderr: "ignore",
		});
	});

	test("a provider is saved only after its connection test passes", async () => {
		const bad = await h.call("POST", "/api/secret-providers/test", {
			...auth(),
			body: { kind: "vault", config: { url: vaultUrl, token: "wrong" } },
		});
		expect(bad.status).toBe(400);
		expect(bad.json.error.message).toContain("HTTP 403");
		const created = await h.call("POST", "/api/secret-providers", {
			...auth(),
			body: {
				kind: "vault",
				name: "vault-dev",
				config: { url: vaultUrl, token: ROOT_TOKEN },
			},
		});
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({ name: "vault-dev", url: vaultUrl });
		expect(JSON.stringify(created.json)).not.toContain(ROOT_TOKEN);
		const list = await h.call("GET", "/api/secret-providers", auth());
		expect(JSON.stringify(list.json)).not.toContain(ROOT_TOKEN);
		expect(
			(
				await h.call(
					"POST",
					`/api/secret-providers/${created.json.id}/test`,
					auth(),
				)
			).status,
		).toBe(200);
	});

	test("references are checked against the provider at the boundary", async () => {
		const create = (reference: string) =>
			h.call("POST", "/api/secrets", {
				...auth(),
				body: { scope: "service", scopeId: serviceId, key: "X", reference },
			});
		expect(
			(await create("secret://nope/secret/app#x")).json.error.message,
		).toContain("no secret provider");
		expect(
			(await create("secret://vault-dev/app#x")).json.error.message,
		).toContain("<mount>");
		expect((await create("secret://vault-dev/secret/app")).status).toBe(400);
	});

	test("deploy-time resolution reads Vault and stores no value", async () => {
		const sec = await h.call("POST", "/api/secrets", {
			...auth(),
			body: {
				scope: "service",
				scopeId: serviceId,
				key: "DB_PASSWORD",
				reference: "secret://vault-dev/secret/app/db#password",
			},
		});
		expect(sec.status).toBe(201);
		expect(sec.json.external).toMatchObject({
			providerName: "vault-dev",
			kind: "vault",
			reference: "secret://vault-dev/secret/app/db#password",
		});
		const saved = await h.call("PUT", `/api/services/${serviceId}/env-vars`, {
			...auth(),
			body: {
				variables: [
					{
						key: "DB_PASSWORD",
						secretId: sec.json.id,
						isSecret: true,
						isBuildTime: false,
					},
					// Typed straight into the service's variables.
					{
						key: "DB_USER",
						value: "secret://vault-dev/secret/app/db#user",
						isSecret: false,
						isBuildTime: false,
					},
				],
			},
		});
		expect(saved.status).toBe(200);

		const sc = await loadService(h.deps, serviceId, { gitAuth: false });
		expect(sc?.env.DB_PASSWORD?.value).toBe("pw-one");
		expect(sc?.env.DB_USER?.value).toBe("app");
		expect(sc?.env.DB_PASSWORD?.snapshotValue).toStartWith(
			`external:${sec.json.id}:`,
		);

		// Nothing in Postgres holds the value, encrypted or not.
		const { db, masterKey } = h.deps;
		const rows = await db
			.select()
			.from(secret)
			.where(eq(secret.scopeId, serviceId));
		expect(rows).toHaveLength(2);
		expect(
			await db
				.select()
				.from(secretVersion)
				.where(
					inArray(
						secretVersion.secretId,
						rows.map((r) => r.id),
					),
				),
		).toHaveLength(0);
		for (const v of await db
			.select()
			.from(envVar)
			.where(eq(envVar.scopeId, serviceId)))
			expect(await decrypt(masterKey, v.valueEncrypted)).toBe("");
		for (const r of rows) {
			expect(r.externalError).toBeNull();
			expect(r.externalCheckedAt).not.toBeNull();
			expect(
				await decrypt(masterKey, r.externalFingerprint ?? ""),
			).not.toContain("pw-one");
		}

		const reveal = await h.call("POST", `/api/secrets/${sec.json.id}/reveal`, {
			...auth(),
			body: {},
		});
		expect(reveal.status).toBe(400);
	});

	test("a value changed in Vault shows up after the periodic check", async () => {
		const { db } = h.deps;
		const [row] = await db
			.select()
			.from(secret)
			.where(eq(secret.key, "DB_PASSWORD"));
		if (!row) throw new Error("missing secret");
		const before = await storedPlaceholder(h.deps, row);
		await kv({ password: "pw-two", user: "app" });
		expect(await recheckExternalSecrets(h.deps)).toEqual({
			checked: 2,
			failed: 0,
		});
		const [after] = await db.select().from(secret).where(eq(secret.id, row.id));
		expect(await storedPlaceholder(h.deps, after as typeof row)).not.toBe(
			before,
		);
		// The placeholder load (pending diff) sees the new hash without contacting Vault.
		const sc = await loadService(h.deps, serviceId, {
			gitAuth: false,
			external: "placeholder",
		});
		expect(sc?.env.DB_PASSWORD?.value).toBe(
			await storedPlaceholder(h.deps, after as typeof row),
		);
	});

	test("a failed resolution fails the deployment before any Docker call", async () => {
		await kv({ password: "pw-three" }); // `user` is gone
		const dep = await h.call("POST", `/api/services/${serviceId}/deploy`, {
			...auth(),
			body: {},
		});
		expect(dep.status).toBeLessThan(300);
		const untouchable = new Proxy(
			{},
			{
				get(_, prop) {
					throw new Error(`touched ${String(prop)} before failing`);
				},
			},
		);
		const ctx = {
			...h.deps,
			docker: untouchable,
			bus: untouchable,
			queues: untouchable,
			nodes: untouchable,
		} as unknown as Ctx;
		await processService(ctx, serviceId);
		const [d] = await h.deps.db
			.select()
			.from(deployment)
			.where(eq(deployment.serviceId, serviceId));
		expect(d?.status).toBe("failed");
		expect(d?.error).toContain(
			"DB_USER (secret://vault-dev/secret/app/db#user)",
		);
		expect(d?.error).toContain('no field "user"');
		expect(d?.error).not.toContain("pw-three");
		expect(d?.specSnapshotEncrypted).toBeNull();
		const [row] = await h.deps.db
			.select()
			.from(secret)
			.where(eq(secret.key, "DB_USER"));
		expect(row?.externalError).toContain('no field "user"');
	});
});
