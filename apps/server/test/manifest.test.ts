import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decrypt } from "@logistack/core";
import { domain, envVar } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { toolsFrom } from "../src/mcp.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const SECRET = "manifest-secret-value";

describe.skipIf(!hasDocker)("project manifests", () => {
	let h: Harness;
	let cookie: string;
	const as = () => ({ headers: { cookie } });
	const call = (method: string, path: string, body?: unknown) =>
		h.call(method, `/api${path}`, { ...as(), body });

	let sourceProject: string;
	let sourceEnv: string;
	let dbId: string;

	const defaultEnv = async (projectId: string) =>
		(await call("GET", `/projects/${projectId}/environments`)).json[0].id;

	beforeAll(async () => {
		h = await startHarness({ area: "mfst", label: "mfst" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		await call("POST", "/s3-destinations", {
			name: "offsite",
			endpoint: "https://s3.eu-central-1.amazonaws.com",
			bucket: "acme-backups",
			accessKeyId: "AKIAEXAMPLE",
			secretAccessKey: "very-secret-key",
		});
		sourceProject = (await call("POST", "/projects", { name: "Shop" })).json.id;
		sourceEnv = await defaultEnv(sourceProject);
		await call("POST", "/env-vars", {
			scope: "environment",
			scopeId: sourceEnv,
			key: "REGION",
			value: "eu",
			isSecret: false,
			isBuildTime: false,
		});
		const web = await call("POST", `/environments/${sourceEnv}/services`, {
			name: "Web",
			spec: {
				kind: "application",
				source: { type: "image", image: "nginx:1.27" },
				build: { type: "image" },
				ports: [{ target: 80, protocol: "tcp" }],
				replicas: 2,
				resources: { memoryMb: 256 },
				placement: [],
			},
			mounts: [
				{ kind: "config", target: "/etc/app.conf", content: "listen 80;" },
				{ kind: "volume", target: "/data", name: "uploads" },
			],
		});
		expect(web.status).toBe(201);
		await call("PUT", `/services/${web.json.id}/env-vars`, {
			variables: [
				{ key: "PUBLIC", value: "1", isSecret: false, isBuildTime: true },
				{ key: "API_KEY", value: SECRET, isSecret: true, isBuildTime: false },
			],
		});
		expect(
			(
				await call("POST", `/services/${web.json.id}/domains`, {
					hostname: "shop.example.com",
					port: 80,
					https: true,
					cert: "auto",
				})
			).status,
		).toBe(201);
		const db = await call("POST", `/environments/${sourceEnv}/services`, {
			name: "db",
			spec: {
				kind: "database",
				engine: "postgres",
				version: "17",
				credentialsRef: "env",
				resources: {},
			},
		});
		dbId = db.json.id;
		const destinations = await call("GET", "/s3-destinations");
		expect(
			(
				await call("POST", `/services/${dbId}/backup-policies`, {
					target: "database",
					s3DestinationId: destinations.json[0].id,
					cron: "0 3 * * *",
					encrypt: true,
				})
			).status,
		).toBe(201);
	}, 60_000);
	afterAll(() => h?.close());

	let exported: { environments: { services: { variables: unknown[] }[] }[] };

	test("export never carries a secret value; org resources go by name", async () => {
		const res = await call("GET", `/projects/${sourceProject}/manifest`);
		expect(res.status).toBe(200);
		exported = res.json;
		const text = JSON.stringify(exported);
		expect(text).not.toContain(SECRET);
		const [minted] = await h.deps.db
			.select()
			.from(envVar)
			.where(
				and(eq(envVar.scopeId, dbId), eq(envVar.key, "POSTGRES_PASSWORD")),
			);
		expect(text).not.toContain(
			await decrypt(h.deps.masterKey, minted?.valueEncrypted ?? ""),
		);
		expect(text).toContain('"destination":"offsite"');
		expect(text).not.toContain("s3d_");
		const yaml = await call(
			"GET",
			`/projects/${sourceProject}/manifest?format=yaml`,
		);
		expect(yaml.headers.get("content-type")).toContain("text/yaml");
		expect(yaml.json).toStartWith("# yaml-language-server: $schema=");
		expect(yaml.json).not.toContain(SECRET);
	});

	test("applying a project's own export to it plans nothing", async () => {
		const res = await call("POST", `/projects/${sourceProject}/apply`, {
			manifest: exported,
			dryRun: true,
		});
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({
			applied: false,
			changes: [],
			warnings: [],
		});
	});

	let target: string;
	let targetEnv: string;

	test("export, then apply into a fresh project, reproduces the same desired state", async () => {
		const yaml = (
			await call("GET", `/projects/${sourceProject}/manifest?format=yaml`)
		).json;
		// Routes are global: free the hostname the copy will claim.
		await h.deps.db
			.delete(domain)
			.where(eq(domain.hostname, "shop.example.com"));
		target = (
			await call("POST", "/projects", { name: "Shop", slug: "shop-copy" })
		).json.id;
		targetEnv = await defaultEnv(target);
		const plan = await call("POST", `/projects/${target}/apply`, {
			manifest: yaml,
			dryRun: true,
		});
		expect(plan.status).toBe(200);
		expect(plan.json.warnings).toEqual([
			"production/web: secret API_KEY has no value in the manifest; set it after applying",
		]);
		// CI supplies the secret the export left out.
		const withSecret = yaml.replace(
			/- key: API_KEY\n(\s+)/,
			(m: string, indent: string) => `${m}value: ${SECRET}\n${indent}`,
		);
		const res = await call("POST", `/projects/${target}/apply`, {
			manifest: withSecret,
		});
		expect(res.status).toBe(200);
		expect(res.json.applied).toBe(true);
		expect(res.json.warnings).toEqual([]);
		expect(res.json.backupKeys).toEqual([
			expect.objectContaining({
				service: "db",
				key: expect.stringMatching(/^AGE-SECRET-KEY-1/),
			}),
		]);
		const copy = (await call("GET", `/projects/${target}/manifest`)).json;
		expect(copy).toEqual(exported);
		const webVars = await h.deps.db
			.select()
			.from(envVar)
			.where(eq(envVar.key, "API_KEY"));
		expect(webVars).toHaveLength(2);
		expect(
			await decrypt(h.deps.masterKey, webVars[1]?.valueEncrypted ?? ""),
		).toBe(SECRET);
	});

	test("applying the same manifest twice is a no-op", async () => {
		const res = await call("POST", `/projects/${target}/apply`, {
			manifest: exported,
		});
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({
			applied: true,
			changes: [],
			backupKeys: [],
		});
	});

	test("an environment manifest goes to an environment, not a project", async () => {
		const env = (await call("GET", `/environments/${targetEnv}/manifest`)).json;
		expect(env.kind).toBe("environment");
		const wrong = await call("POST", `/projects/${target}/apply`, {
			manifest: env,
		});
		expect(wrong.status).toBe(400);
		const ok = await call("POST", `/environments/${targetEnv}/apply`, {
			manifest: env,
			dryRun: true,
		});
		expect(ok.json.changes).toEqual([]);
	});

	test("unknown organization resources are a 400 naming them", async () => {
		const env = (await call("GET", `/environments/${targetEnv}/manifest`)).json;
		env.environment.services[0].backups[0].destination = "nowhere";
		const res = await call("POST", `/environments/${targetEnv}/apply`, {
			manifest: env,
			dryRun: true,
		});
		expect(res.status).toBe(400);
		expect(res.json.error.details).toEqual([
			'S3 destination "nowhere" does not exist in this organization',
		]);
	});

	test("what the manifest does not list is deleted only with prune", async () => {
		await call("POST", `/environments/${targetEnv}/services`, {
			name: "extra",
			spec: {
				kind: "application",
				source: { type: "image", image: "redis:7" },
				build: { type: "image" },
				ports: [],
				replicas: 1,
				resources: {},
				placement: [],
			},
		});
		const kept = await call("POST", `/projects/${target}/apply`, {
			manifest: exported,
		});
		expect(kept.json.changes).toEqual([]);
		const plan = await call("POST", `/projects/${target}/apply`, {
			manifest: exported,
			prune: true,
			dryRun: true,
		});
		expect(plan.json.changes).toEqual([
			{
				op: "delete",
				resource: "service",
				environment: "production",
				name: "extra",
				changes: ["removed"],
			},
		]);
		const pruned = await call("POST", `/projects/${target}/apply`, {
			manifest: exported,
			prune: true,
		});
		expect(pruned.json.changes).toHaveLength(1);
		expect((await call("GET", `/projects/${target}/manifest`)).json).toEqual(
			exported,
		);
	});

	test("duplicating an environment copies services and secrets, not domains or backups", async () => {
		const res = await call("POST", `/environments/${sourceEnv}/duplicate`, {
			name: "Staging",
			kind: "staging",
		});
		expect(res.status).toBe(201);
		expect(res.json.environment).toMatchObject({
			slug: "staging",
			kind: "staging",
		});
		expect(res.json.warnings).toEqual([]);
		const copy = (
			await call("GET", `/environments/${res.json.environment.id}/manifest`)
		).json.environment;
		const source = (await call("GET", `/environments/${sourceEnv}/manifest`))
			.json.environment;
		expect(copy.services.map((s: { slug: string }) => s.slug)).toEqual(
			source.services.map((s: { slug: string }) => s.slug),
		);
		expect(copy.variables).toEqual(source.variables);
		for (const s of copy.services) {
			expect(s.domains).toEqual([]);
			expect(s.backups).toEqual([]);
		}
		const apiKeys = await h.deps.db
			.select()
			.from(envVar)
			.where(eq(envVar.key, "API_KEY"));
		const values = await Promise.all(
			apiKeys.map((v) => decrypt(h.deps.masterKey, v.valueEncrypted)),
		);
		expect(values.filter((v) => v === SECRET).length).toBe(apiKeys.length);

		const again = await call("POST", `/environments/${sourceEnv}/duplicate`, {
			name: "Staging",
			kind: "staging",
		});
		expect(again.status).toBe(409);
	});

	test("duplicating without variables leaves them out", async () => {
		const res = await call("POST", `/environments/${sourceEnv}/duplicate`, {
			name: "Bare",
			kind: "custom",
			includeVariables: false,
		});
		expect(res.status).toBe(201);
		const copy = (
			await call("GET", `/environments/${res.json.environment.id}/manifest`)
		).json.environment;
		expect(copy.variables).toEqual([]);
		const web = copy.services.find((s: { slug: string }) => s.slug === "web");
		expect(web.variables).toEqual([]);
	});

	test("MCP exposes export, plan and apply as tools", async () => {
		const doc = await h.call("GET", "/api/openapi.json");
		const names = toolsFrom(doc.json)
			.filter((t) =>
				/^\/(projects|environments)\/{id}\/(manifest|apply|duplicate)$|^\/manifest\//.test(
					t.path,
				),
			)
			.map((t) => t.name)
			.sort();
		expect(names).toEqual([
			"environment_apply",
			"environment_duplicate",
			"get_environments_by_id_manifest",
			"get_manifest_schema_json",
			"get_projects_by_id_manifest",
			"project_apply",
		]);
	});
});
