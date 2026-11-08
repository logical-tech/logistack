import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decrypt, encrypt, loadMasterKeys } from "@logistack/core";
import { envVar, gitProvider } from "@logistack/db";
import { loadService } from "@logistack/worker/load";
import { rotateMasterKey, v1Columns } from "@logistack/worker/master-key";
import { readSecretValues } from "@logistack/worker/secrets";
import { eq, like } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const imageSpec = {
	kind: "application",
	source: { type: "image", image: "nginx:1.27" },
	build: { type: "image" },
	ports: [{ target: 80, protocol: "tcp" }],
	replicas: 1,
	resources: { memoryMb: 128 },
	placement: [],
};

describe.skipIf(!hasDocker)("secrets phase 2", () => {
	let h: Harness;
	let cookie: string;
	let orgId: string;
	let projectId: string;
	let environmentId: string;
	let serviceId: string;
	let pgSecretId: string;
	const call = (method: string, path: string, body?: unknown) =>
		h.call(method, `/api${path}`, { headers: { cookie }, body });
	const load = (id = serviceId) => loadService(h.deps, id, { gitAuth: false });

	beforeAll(async () => {
		h = await startHarness({ area: "secrets2", label: "secrets2" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		orgId = (await call("GET", "/organization")).json.id;
		projectId = (await call("POST", "/projects", { name: "Shop" })).json.id;
		environmentId = (await call("GET", `/projects/${projectId}/environments`))
			.json[0].id;
		serviceId = (
			await call("POST", `/environments/${environmentId}/services`, {
				name: "Web",
				spec: imageSpec,
			})
		).json.id;
		pgSecretId = (
			await call("POST", "/secrets", {
				scope: "organization",
				scopeId: orgId,
				key: "PG_PASSWORD",
				value: "org-pg-pass",
			})
		).json.id;
	}, 90_000);
	afterAll(() => h?.close());

	test("${{ secrets.KEY }} in a plain value resolves to the most specific secret at deploy", async () => {
		await call("POST", "/secrets", {
			scope: "project",
			scopeId: projectId,
			key: "PG_PASSWORD",
			value: "project-pg-pass",
		});
		const put = await call("PUT", `/services/${serviceId}/env-vars`, {
			variables: [
				{
					key: "DATABASE_URL",
					value: "postgres://app:${{ secrets.PG_PASSWORD }}@db/app",
					// Marked secret by habit: still stored plain, so the reference resolves.
					isSecret: true,
					isBuildTime: false,
				},
			],
		});
		expect(put.status).toBe(200);
		expect(put.json[0]).toMatchObject({ isSecret: false, secretId: null });
		const env = (await load())?.env;
		expect(env?.DATABASE_URL).toMatchObject({
			value: "postgres://app:project-pg-pass@db/app",
			isSecret: true,
		});
	});

	test("an unknown secret name fails the load with the key that uses it", async () => {
		await call("PUT", `/services/${serviceId}/env-vars`, {
			variables: [
				{
					key: "TOKEN",
					value: "${{ secrets.NOPE }}",
					isSecret: false,
					isBuildTime: false,
				},
			],
		});
		await expect(load()).rejects.toThrow(
			"TOKEN uses ${{ secrets.NOPE }}, but no secret",
		);
	});

	test("a reference mounted as a file becomes a Swarm secret mount, not an env var", async () => {
		const put = await call("PUT", `/services/${serviceId}/env-vars`, {
			variables: [
				{
					key: "DB_PASSWORD",
					secretId: pgSecretId,
					isSecret: true,
					isBuildTime: false,
					asFile: true,
				},
			],
		});
		expect(put.status).toBe(200);
		expect(put.json[0]).toMatchObject({ asFile: true, secretId: pgSecretId });
		const sc = await load();
		expect(sc?.env.DB_PASSWORD).toBeUndefined();
		expect(sc?.env.DB_PASSWORD_FILE?.value).toBe("/run/secrets/DB_PASSWORD");
		expect(sc?.mounts).toContainEqual(
			expect.objectContaining({
				kind: "secret",
				target: "/run/secrets/DB_PASSWORD",
				content: "org-pg-pass",
			}),
		);
		const bad = await call("PUT", `/services/${serviceId}/env-vars`, {
			variables: [
				{
					key: "A",
					value: "x",
					isSecret: false,
					isBuildTime: false,
					asFile: true,
				},
			],
		});
		expect(bad.status).toBe(400);
	});

	test("an exported manifest names references and holds no secret value; it applies with no diff", async () => {
		await call("PUT", `/services/${serviceId}/env-vars`, {
			variables: [
				{
					key: "DB_PASSWORD",
					secretId: pgSecretId,
					isSecret: true,
					isBuildTime: false,
					asFile: true,
				},
				{
					key: "OWN",
					value: "own-secret-value",
					isSecret: true,
					isBuildTime: false,
				},
				{
					key: "URL",
					value: "x://${{ secrets.PG_PASSWORD }}",
					isSecret: false,
					isBuildTime: false,
				},
			],
		});
		const yaml = (
			await call("GET", `/projects/${projectId}/manifest?format=yaml`)
		).json as string;
		for (const plain of ["org-pg-pass", "project-pg-pass", "own-secret-value"])
			expect(yaml).not.toContain(plain);
		const json = (await call("GET", `/projects/${projectId}/manifest`)).json;
		const vars = json.environments[0].services[0].variables;
		expect(vars).toContainEqual({
			key: "DB_PASSWORD",
			secret: true,
			buildTime: false,
			secretRef: { key: "PG_PASSWORD", scope: "organization" },
			asFile: true,
		});
		expect(vars).toContainEqual({ key: "OWN", secret: true, buildTime: false });
		const plan = await call("POST", `/projects/${projectId}/apply`, {
			manifest: yaml,
			dryRun: true,
		});
		expect(plan.status).toBe(200);
		expect(plan.json.changes).toEqual([]);

		// The same manifest applied to a fresh project recreates the reference by name.
		const other = (await call("POST", "/projects", { name: "Shop copy" })).json
			.id;
		const copy = { ...json, project: { name: "Shop copy" } };
		const out = await call("POST", `/projects/${other}/apply`, {
			manifest: copy,
		});
		expect(out.status).toBe(200);
		const env = (await call("GET", `/projects/${other}/environments`)).json[0];
		const svc = (await call("GET", `/environments/${env.id}/services`)).json[0];
		const rows = await h.deps.db
			.select()
			.from(envVar)
			.where(eq(envVar.scopeId, svc.id));
		expect(rows.find((r) => r.key === "DB_PASSWORD")).toMatchObject({
			secretId: pgSecretId,
			asFile: true,
		});
	});

	test("after a master key rotation every value and every secret opens with the new key", async () => {
		await h.deps.db.insert(gitProvider).values({
			organizationId: orgId,
			kind: "github",
			name: "gh",
			configEncrypted: await encrypt(h.deps.masterKey, '{"token":"ghp_x"}'),
		} as never);
		const oldB64 = h.config.LOGISTACK_MASTER_KEY;
		const newB64 = crypto.getRandomValues(new Uint8Array(32)).toBase64();
		const first = await rotateMasterKey(h.deps.db, newB64, oldB64);
		expect(first.unreadable).toBe(0);
		expect(first.values).toBeGreaterThan(0);
		expect(first.dataKeys).toBeGreaterThan(0);
		// Idempotent: a second pass finds nothing left.
		expect(await rotateMasterKey(h.deps.db, newB64, oldB64)).toEqual({
			values: 0,
			dataKeys: 0,
			unreadable: 0,
		});
		const fresh = await loadMasterKeys(newB64);
		for (const c of v1Columns) {
			const rows = (await h.deps.db
				.select({ v: c.value })
				.from(c.table)
				.where(like(c.value, "v1:%"))) as { v: string }[];
			for (const r of rows) await decrypt(fresh.masterKey, r.v);
		}
		const ids = [pgSecretId];
		const values = await readSecretValues({ db: h.deps.db, ...fresh }, ids);
		expect(values.get(pgSecretId)?.value).toBe("org-pg-pass");
		const sc = await loadService({ db: h.deps.db, ...fresh }, serviceId, {
			gitAuth: false,
		});
		expect(sc?.env.URL?.value).toBe("x://project-pg-pass");
		// The old key alone opens nothing any more; with a fallback, mid-rotation readers still work.
		const old = await loadMasterKeys(oldB64);
		await expect(
			readSecretValues({ db: h.deps.db, ...old }, ids),
		).rejects.toThrow();
		const both = await loadMasterKeys(newB64, oldB64);
		expect((await readSecretValues({ db: h.deps.db, ...both }, ids)).size).toBe(
			1,
		);
	});
});
