import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	compileService,
	decrypt,
	generateInput,
	planTemplate,
} from "@logistack/core";
import {
	auditLog,
	deployment,
	domain,
	envVar,
	mount,
	service,
} from "@logistack/db";
import { catalogIndex, readTemplate } from "@logistack/templates";
import { and, eq, inArray } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

/** `umami` is an app and a postgres named `db`; the app's DATABASE_URL points at `db`. */
const TEMPLATE = "umami";

describe.skipIf(!hasDocker)("templates API", () => {
	let h: Harness;
	let cookie: string;
	let envId: string;
	let otherEnvId: string;
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "tpl", label: "tpl" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const project = await h.call("POST", "/api/projects", {
			...as(),
			body: { name: "Analytics" },
		});
		const envs = await h.call(
			"GET",
			`/api/projects/${project.json.id}/environments`,
			as(),
		);
		envId = envs.json[0].id;
		otherEnvId = (
			await h.call("POST", `/api/projects/${project.json.id}/environments`, {
				...as(),
				body: { name: "Staging", kind: "staging" },
			})
		).json.id;
	}, 60_000);
	afterAll(() => h?.close());

	test("the index searches and filters by category", async () => {
		const all = await h.call("GET", "/api/templates", as());
		expect(all.status).toBe(200);
		expect(all.json.length).toBeGreaterThan(300);
		const hit = await h.call(
			"GET",
			"/api/templates?q=umami&category=analytics",
			as(),
		);
		expect(hit.json.map((t: { id: string }) => t.id)).toContain(TEMPLATE);
		const none = await h.call(
			"GET",
			"/api/templates?q=umami&category=media",
			as(),
		);
		expect(none.json).toEqual([]);
	});

	test("one template, its logo, and 404s", async () => {
		const t = await h.call("GET", `/api/templates/${TEMPLATE}`, as());
		expect(t.json).toMatchObject({ id: TEMPLATE, schema: 1 });
		const logo = await h.call("GET", `/api/templates/${TEMPLATE}/logo`, as());
		expect(logo.status).toBe(200);
		expect(logo.headers.get("content-type")).toMatch(/^image\//);
		expect((await h.call("GET", "/api/templates/nope", as())).status).toBe(404);
		expect((await h.call("GET", "/api/templates/../etc", as())).status).toBe(
			404,
		);
		expect((await h.call("GET", "/api/templates")).status).toBe(401);
	});

	test("bad inputs are refused before anything is written", async () => {
		const res = await h.call(
			"POST",
			`/api/environments/${envId}/templates/${TEMPLATE}`,
			{
				...as(),
				body: { inputs: { nope: "x", mainDomain: "not a host" } },
			},
		);
		expect(res.status).toBe(400);
		expect(res.json.error.details).toEqual([
			`nope: not an input of ${TEMPLATE}`,
			"mainDomain: not a hostname",
		]);
		const rows = await h.deps.db
			.select()
			.from(service)
			.where(eq(service.environmentId, envId));
		expect(rows).toEqual([]);
	});

	let created: {
		id: string;
		name: string;
		kind: string;
		deploymentId: string;
		hostname: string | null;
	}[];

	test("deploy creates app + postgres in dependency order with secrets, a domain and queued deploys", async () => {
		const res = await h.call(
			"POST",
			`/api/environments/${envId}/templates/${TEMPLATE}`,
			{
				...as(),
				body: { inputs: {} },
			},
		);
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({
			created: true,
			name: TEMPLATE,
			templateId: TEMPLATE,
		});
		created = res.json.services;
		expect(created.map((s) => [s.name, s.kind])).toEqual([
			["db", "database"],
			["umami", "application"],
		]);
		const app = created[1];
		expect(app?.hostname).toMatch(
			/^umami-[a-z0-9]{6}\.203-0-113-7\.sslip\.io$/,
		);

		const { db, masterKey } = h.deps;
		const vars = await db
			.select()
			.from(envVar)
			.where(
				and(
					eq(envVar.scope, "service"),
					inArray(
						envVar.scopeId,
						created.map((s) => s.id),
					),
				),
			);
		const env = async (serviceId: string) =>
			Object.fromEntries(
				await Promise.all(
					vars
						.filter((v) => v.scopeId === serviceId)
						.map(async (v) => [
							v.key,
							{
								value: await decrypt(masterKey, v.valueEncrypted),
								secret: v.isSecret,
							},
						]),
				),
			);
		const appEnv = await env(app?.id as string);
		const dbEnv = await env(created[0]?.id as string);
		// The generated password is shared, stored as a secret, and the app reaches the database at `db`.
		const password = dbEnv.POSTGRES_PASSWORD.value;
		expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
		expect(dbEnv.POSTGRES_PASSWORD.secret).toBe(true);
		expect(appEnv.DATABASE_URL).toEqual({
			value: `postgresql://umami:${password}@db:5432/umami`,
			secret: true,
		});
		expect(appEnv.APP_SECRET.secret).toBe(true);
		expect(appEnv.DATABASE_TYPE).toEqual({
			value: "postgresql",
			secret: false,
		});

		const rows = await db
			.select()
			.from(service)
			.where(eq(service.environmentId, envId));
		expect(rows.map((r) => [r.slug, r.importedFrom]).sort()).toEqual([
			["db", `template:${TEMPLATE}:${TEMPLATE}/db`],
			["umami", `template:${TEMPLATE}:${TEMPLATE}/umami`],
		]);
		const [dom] = await db
			.select()
			.from(domain)
			.where(eq(domain.serviceId, app?.id as string));
		expect(dom).toMatchObject({
			hostname: app?.hostname,
			port: 3000,
			isGenerated: true,
		});
		const deps = await db
			.select()
			.from(deployment)
			.where(
				inArray(
					deployment.serviceId,
					created.map((s) => s.id),
				),
			);
		expect(deps.map((d) => d.status)).toEqual(["queued", "queued"]);
		// The database's engine volume replaces the template's volume at the data dir.
		expect(
			await db
				.select()
				.from(mount)
				.where(
					inArray(
						mount.serviceId,
						created.map((s) => s.id),
					),
				),
		).toEqual([]);

		// What the worker would compile: both on the environment network, aliased by slug.
		const nets = rows.map(
			(r) =>
				compileService({
					service: { ...r, organizationId: "org", spec: r.spec as never },
					deploymentId: "dep_x",
					image: "img:1",
					env: r.slug === "db" ? { POSTGRES_PASSWORD: password } : {},
					mounts: [],
					domains: [],
					networks: { environment: "env-net", ingress: "ingress-net" },
					pinNodeId: "n",
					fileIds: {},
				}).TaskTemplate.Networks?.[0],
		);
		expect(nets).toEqual([
			{ Target: "env-net", Aliases: [rows[0]?.slug as string] },
			{ Target: "env-net", Aliases: [rows[1]?.slug as string] },
		]);
	});

	test("a repeat with the same instance name returns the first result and creates nothing", async () => {
		const res = await h.call(
			"POST",
			`/api/environments/${envId}/templates/${TEMPLATE}`,
			{
				...as(),
				body: { inputs: { mainDomain: "other.example.com" } },
			},
		);
		expect(res.status).toBe(200);
		expect(res.json.created).toBe(false);
		expect(res.json.services.map((s: { id: string }) => s.id).sort()).toEqual(
			created.map((s) => s.id).sort(),
		);
		const rows = await h.deps.db
			.select()
			.from(service)
			.where(eq(service.environmentId, envId));
		expect(rows).toHaveLength(2);
	});

	test("another instance name in the same environment collides on the aliases", async () => {
		const res = await h.call(
			"POST",
			`/api/environments/${envId}/templates/${TEMPLATE}`,
			{
				...as(),
				body: { name: "second", inputs: {} },
			},
		);
		expect(res.status).toBe(409);
		expect(res.json.error.details.conflicts.sort()).toEqual(["db", "umami"]);
	});

	test("a user domain is used as is, and the audit row carries input keys, never values", async () => {
		const res = await h.call(
			"POST",
			`/api/environments/${otherEnvId}/templates/${TEMPLATE}`,
			{
				...as(),
				body: {
					name: "stats",
					inputs: {
						mainDomain: "Stats.Example.com",
						dbPassword: "chosen-by-me-123",
					},
				},
			},
		);
		expect(res.status).toBe(201);
		const app = res.json.services.find(
			(s: { name: string }) => s.name === "umami",
		);
		expect(app.hostname).toBe("stats.example.com");
		const [dom] = await h.deps.db
			.select()
			.from(domain)
			.where(eq(domain.serviceId, app.id));
		expect(dom?.isGenerated).toBe(false);
		const audits = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "template.deploy"));
		const last = audits.find(
			(a) =>
				a.outcome === "success" && JSON.stringify(a.diff).includes("stats"),
		);
		expect(last?.diff).toEqual({
			templateId: TEMPLATE,
			name: "stats",
			inputs: ["mainDomain", "dbPassword"],
		});
		expect(JSON.stringify(audits)).not.toContain("chosen-by-me-123");
	});
});

describe("catalog", () => {
	test("every template plans with generated values and compiles", () => {
		for (const { id } of catalogIndex()) {
			const t = readTemplate(id) as NonNullable<
				ReturnType<typeof readTemplate>
			>;
			const values = Object.fromEntries(
				t.inputs.map((i) => [
					i.key,
					i.type === "domain"
						? `${i.key.toLowerCase()}.example.com`
						: (generateInput(i) ?? "x"),
				]),
			);
			for (const p of planTemplate(t, values)) {
				const spec = compileService({
					service: {
						id: "svc_x",
						organizationId: "org",
						environmentId: "env_x",
						slug: p.name,
						desiredState: "running",
						spec: p.spec,
					},
					deploymentId: "dep_x",
					image:
						p.spec.kind === "application" && p.spec.source.type === "image"
							? p.spec.source.image
							: "x",
					env: Object.fromEntries(p.env.map((e) => [e.key, e.value])),
					mounts: [],
					domains: p.domain ? [{ port: p.domain.port }] : [],
					networks: { environment: "e", ingress: "i" },
					pinNodeId: "n",
					fileIds: {},
				});
				expect(JSON.stringify(spec)).not.toContain("${{");
			}
		}
	});
});
