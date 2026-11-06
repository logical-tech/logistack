import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt } from "@logistack/core";
import { auditLog, envVar, secret, secretVersion } from "@logistack/db";
import { loadService } from "@logistack/worker/load";
import { convertLegacySecrets } from "@logistack/worker/secrets";
import { and, eq } from "drizzle-orm";
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
	resources: { memoryMb: 512 },
	placement: [],
};

describe.skipIf(!hasDocker)("managed secrets", () => {
	let h: Harness;
	let cookie: string;
	let orgId: string;
	let folderId: string;
	let projectId: string;
	let environmentId: string;
	let serviceId: string;
	let otherServiceId: string;
	let devKey: Record<string, string>;
	const auth = () => ({ headers: { cookie } });
	const env = async (id = serviceId) =>
		(await loadService(h.deps, id, { gitAuth: false }))?.env;

	beforeAll(async () => {
		h = await startHarness({ area: "secrets", label: "secrets" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		orgId = (await h.call("GET", "/api/organization", auth())).json.id;
		folderId = (
			await h.call("POST", "/api/folders", {
				...auth(),
				body: { name: "Clients" },
			})
		).json.id;
		projectId = (
			await h.call("POST", "/api/projects", {
				...auth(),
				body: { name: "Shop", folderId },
			})
		).json.id;
		environmentId = (
			await h.call("GET", `/api/projects/${projectId}/environments`, auth())
		).json[0].id;
		const svc = async (name: string) =>
			(
				await h.call("POST", `/api/environments/${environmentId}/services`, {
					...auth(),
					body: { name, spec: imageSpec },
				})
			).json.id;
		serviceId = await svc("Web");
		otherServiceId = await svc("Api");
		const key = await h.call("POST", "/api/api-keys", {
			...auth(),
			body: {
				name: "dev",
				scopes: [
					{ role: "developer", scope: { kind: "organization", id: orgId } },
				],
			},
		});
		devKey = { authorization: `Bearer ${key.json.key}` };
	}, 90_000);
	afterAll(() => h?.close());

	const create = (scope: string, scopeId: string, key: string, value: string) =>
		h.call("POST", "/api/secrets", {
			...auth(),
			body: { scope, scopeId, key, value },
		});

	test("a secret is stored v2, bound to its row, and never listed with a value", async () => {
		const res = await create(
			"organization",
			orgId,
			"STRIPE_KEY",
			"sk_live_123",
		);
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({
			key: "STRIPE_KEY",
			version: 1,
			usedBy: 0,
		});
		expect(JSON.stringify(res.json)).not.toContain("sk_live_123");
		const [v] = await h.deps.db
			.select()
			.from(secretVersion)
			.where(eq(secretVersion.secretId, res.json.id));
		expect(v?.valueEncrypted.startsWith("v2:")).toBe(true);
		const list = await h.call(
			"GET",
			`/api/secrets?scope=organization&scopeId=${orgId}`,
			auth(),
		);
		expect(JSON.stringify(list.json)).not.toContain("sk_live_123");
	});

	test("a secret is injected only into services that reference it", async () => {
		const org = await create(
			"organization",
			orgId,
			"SHARED_TOKEN",
			"tok-org-1",
		);
		const fld = await create(
			"folder",
			folderId,
			"SHARED_TOKEN",
			"tok-folder-1",
		);
		const available = await h.call(
			"GET",
			`/api/secrets/available?serviceId=${serviceId}`,
			auth(),
		);
		const shared = available.json.filter(
			(s: { key: string }) => s.key === "SHARED_TOKEN",
		);
		expect(
			shared.map((s: { scope: string; shadowed: boolean }) => [
				s.scope,
				s.shadowed,
			]),
		).toEqual([
			["folder", false],
			["organization", true],
		]);
		const put = await h.call("PUT", `/api/services/${serviceId}/env-vars`, {
			...auth(),
			body: {
				variables: [
					{
						key: "TOKEN",
						isSecret: true,
						isBuildTime: false,
						secretId: fld.json.id,
					},
					{
						key: "DB_PASSWORD",
						value: "typed-pass-1",
						isSecret: true,
						isBuildTime: false,
					},
					{ key: "MODE", value: "prod", isSecret: false, isBuildTime: false },
				],
			},
		});
		expect(put.status).toBe(200);
		expect(
			put.json.every(
				(v: { key: string; value: string | null }) =>
					v.key === "MODE" || v.value === null,
			),
		).toBe(true);
		const e = await env();
		expect(e?.TOKEN?.value).toBe("tok-folder-1");
		expect(e?.DB_PASSWORD?.value).toBe("typed-pass-1");
		expect(e?.MODE?.value).toBe("prod");
		expect(e?.SHARED_TOKEN).toBeUndefined();
		expect((await env(otherServiceId))?.TOKEN).toBeUndefined();
		// Typed text became the service's own secret.
		const own = await h.call(
			"GET",
			`/api/secrets?scope=service&scopeId=${serviceId}`,
			auth(),
		);
		expect(own.json.map((s: { key: string }) => s.key)).toEqual([
			"DB_PASSWORD",
		]);
		expect(org.status).toBe(201);
	});

	test("a reference outside the service's chain is refused", async () => {
		const elsewhere = await create(
			"service",
			otherServiceId,
			"ONLY_API",
			"x-api",
		);
		const put = await h.call("PUT", `/api/services/${serviceId}/env-vars`, {
			...auth(),
			body: {
				variables: [
					{
						key: "X",
						isSecret: true,
						isBuildTime: false,
						secretId: elsewhere.json.id,
					},
				],
			},
		});
		expect(put.status).toBe(400);
	});

	test("a new value is a new version; the next deploy picks it up and rollback restores", async () => {
		const [row] = await h.deps.db
			.select()
			.from(secret)
			.where(and(eq(secret.scope, "folder"), eq(secret.key, "SHARED_TOKEN")));
		const id = row?.id as string;
		const patched = await h.call("PATCH", `/api/secrets/${id}`, {
			...auth(),
			body: { value: "tok-folder-2" },
		});
		expect(patched.json.version).toBe(2);
		expect((await env())?.TOKEN?.value).toBe("tok-folder-2");
		// The previous release's copy on the referencing row follows the new value.
		const versions = await h.call("GET", `/api/secrets/${id}/versions`, auth());
		expect(versions.json.map((v: { version: number }) => v.version)).toEqual([
			2, 1,
		]);
		const back = await h.call("POST", `/api/secrets/${id}/rollback`, {
			...auth(),
			body: { version: 1 },
		});
		expect(back.json.version).toBe(3);
		expect((await env())?.TOKEN?.value).toBe("tok-folder-1");
	});

	test("reveal needs read:secrets and is audited", async () => {
		const [row] = await h.deps.db
			.select()
			.from(secret)
			.where(and(eq(secret.scope, "folder"), eq(secret.key, "SHARED_TOKEN")));
		const id = row?.id as string;
		const denied = await h.call("POST", `/api/secrets/${id}/reveal`, {
			headers: devKey,
			body: {},
		});
		expect(denied.status).toBe(403);
		const ok = await h.call("POST", `/api/secrets/${id}/reveal`, {
			...auth(),
			body: { version: 2 },
		});
		expect(ok.json).toEqual({ version: 2, value: "tok-folder-2" });
		expect(ok.headers.get("cache-control")).toBe("no-store");
		const audits = await h.deps.db
			.select()
			.from(auditLog)
			.where(
				and(eq(auditLog.action, "secret.reveal"), eq(auditLog.resourceId, id)),
			);
		expect(audits.map((a) => a.outcome).sort()).toEqual(["denied", "success"]);
		expect(JSON.stringify(audits)).not.toContain("tok-folder");
		// A developer can still reference what it can read, without seeing values.
		const list = await h.call("GET", `/api/services/${serviceId}/env-vars`, {
			headers: devKey,
		});
		expect(JSON.stringify(list.json)).not.toContain("tok-folder");
	});

	test("a referenced secret cannot be deleted; an unreferenced one can", async () => {
		const [row] = await h.deps.db
			.select()
			.from(secret)
			.where(and(eq(secret.scope, "folder"), eq(secret.key, "SHARED_TOKEN")));
		const del = await h.call("DELETE", `/api/secrets/${row?.id}`, auth());
		expect(del.status).toBe(409);
		expect(del.json.error.details.usages[0]).toMatchObject({
			key: "TOKEN",
			serviceId,
		});
		const lone = await create("project", projectId, "UNUSED", "nothing");
		expect(
			(await h.call("DELETE", `/api/secrets/${lone.json.id}`, auth())).status,
		).toBe(204);
	});

	test("removing a typed secret variable removes the service secret behind it", async () => {
		await h.call("PUT", `/api/services/${serviceId}/env-vars`, {
			...auth(),
			body: {
				variables: [
					{ key: "MODE", value: "prod", isSecret: false, isBuildTime: false },
				],
			},
		});
		const own = await h.call(
			"GET",
			`/api/secrets?scope=service&scopeId=${serviceId}`,
			auth(),
		);
		expect(own.json).toEqual([]);
	});

	test("rotating the data key keeps every value readable", async () => {
		const rotated = await h.call(
			"POST",
			"/api/organization/secret-keys/rotate",
			auth(),
		);
		expect(rotated.status).toBe(200);
		expect(rotated.json.version).toBe(2);
		expect(rotated.json.reencrypted).toBeGreaterThan(0);
		const rows = await h.deps.db.select().from(secretVersion);
		expect(rows.every((r) => r.dekVersion === 2)).toBe(true);
		const [row] = await h.deps.db
			.select()
			.from(secret)
			.where(eq(secret.key, "STRIPE_KEY"));
		const ok = await h.call("POST", `/api/secrets/${row?.id}/reveal`, {
			...auth(),
			body: {},
		});
		expect(ok.json.value).toBe("sk_live_123");
		expect(
			(
				await h.call("POST", "/api/organization/secret-keys/rotate", {
					headers: devKey,
				})
			).status,
		).toBe(403);
	});

	test("a ciphertext swapped into another row does not decrypt", async () => {
		const a = await create("project", projectId, "SWAP_A", "value-a");
		const b = await create("project", projectId, "SWAP_B", "value-b");
		const [va] = await h.deps.db
			.select()
			.from(secretVersion)
			.where(eq(secretVersion.secretId, a.json.id));
		await h.deps.db
			.update(secretVersion)
			.set({ valueEncrypted: va?.valueEncrypted as string })
			.where(eq(secretVersion.secretId, b.json.id));
		const res = await h.call("POST", `/api/secrets/${b.json.id}/reveal`, {
			...auth(),
			body: {},
		});
		expect(res.status).toBe(500);
		expect(JSON.stringify(res.json)).not.toContain("value-a");
	});

	test("legacy secret variables convert without changing any service's env", async () => {
		const legacy = async (
			scope: "project" | "service",
			scopeId: string,
			key: string,
			value: string,
		) =>
			h.deps.db.insert(envVar).values({
				scope,
				scopeId,
				key,
				isSecret: true,
				valueEncrypted: await encrypt(h.deps.masterKey, value),
			});
		await legacy("project", projectId, "LEGACY_SHARED", "legacy-1");
		await legacy("service", otherServiceId, "LEGACY_SHARED", "override-api");
		await legacy("service", otherServiceId, "LEGACY_OWN", "own-api");
		const before = [await env(), await env(otherServiceId)];
		expect(await convertLegacySecrets(h.deps)).toBe(3);
		expect(await convertLegacySecrets(h.deps)).toBe(0);
		const after = [await env(), await env(otherServiceId)];
		const values = (e: typeof before) =>
			e.map((x) =>
				Object.fromEntries(
					Object.entries(x ?? {}).map(([k, v]) => [k, v.value]),
				),
			);
		expect(values(after)).toEqual(values(before));
		expect(after[0]?.LEGACY_SHARED?.value).toBe("legacy-1");
		expect(after[1]?.LEGACY_SHARED?.value).toBe("override-api");
		const projectLevel = await h.deps.db
			.select()
			.from(envVar)
			.where(and(eq(envVar.scope, "project"), eq(envVar.scopeId, projectId)));
		expect(projectLevel).toEqual([]);
	});

	test("deleting a service removes its variables and own secrets", async () => {
		const svc = (
			await h.call("POST", `/api/environments/${environmentId}/services`, {
				...auth(),
				body: { name: "Tmp", spec: imageSpec },
			})
		).json.id;
		await h.call("PUT", `/api/services/${svc}/env-vars`, {
			...auth(),
			body: {
				variables: [
					{ key: "P", value: "tmp-pass", isSecret: true, isBuildTime: false },
				],
			},
		});
		expect(
			(await h.call("DELETE", `/api/services/${svc}`, auth())).status,
		).toBeLessThan(300);
		expect(
			await h.deps.db.select().from(secret).where(eq(secret.scopeId, svc)),
		).toEqual([]);
		expect(
			await h.deps.db.select().from(envVar).where(eq(envVar.scopeId, svc)),
		).toEqual([]);
	});
});
