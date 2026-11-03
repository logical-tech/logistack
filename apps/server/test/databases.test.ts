import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt } from "@logistack/core";
import { createDb, envVar } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const dbSpec = {
	kind: "database",
	engine: "postgres",
	version: "18-alpine",
	credentialsRef: "env",
	resources: {},
};

describe.skipIf(!hasDocker)("database explorer API", () => {
	let h: Harness;
	let cookie: string;
	let envId: string;
	let dbId: string;
	let target: { host: string; port: number };

	const setEnv = async (key: string, value: string) => {
		await h.deps.db
			.delete(envVar)
			.where(and(eq(envVar.scopeId, dbId), eq(envVar.key, key)));
		await h.deps.db.insert(envVar).values({
			scope: "service",
			scopeId: dbId,
			key,
			valueEncrypted: await encrypt(h.deps.masterKey, value),
		});
	};
	const schema = (id = dbId, headers: Record<string, string> = { cookie }) =>
		h.call("GET", `/api/databases/${id}/schema`, { headers });

	beforeAll(async () => {
		h = await startHarness({ area: "dbx", label: "dbx" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const prj = await h.call("POST", "/api/projects", {
			headers: { cookie },
			body: { name: "Shop" },
		});
		envId = (
			await h.call("GET", `/api/projects/${prj.json.id}/environments`, {
				headers: { cookie },
			})
		).json[0].id;
		dbId = (
			await h.call("POST", `/api/environments/${envId}/services`, {
				headers: { cookie },
				body: { name: "orders-db", spec: dbSpec },
			})
		).json.id;

		// The harness's own Postgres stands in for the service; a separate database keeps it apart.
		const url = new URL(h.config.DATABASE_URL);
		target = { host: url.hostname, port: Number(url.port) };
		const admin = createDb(h.config.DATABASE_URL, {
			onnotice: () => {},
		}).$client;
		await admin.unsafe("create database shop");
		await admin.end();
		url.pathname = "/shop";
		const shop = createDb(url.toString(), { onnotice: () => {} }).$client;
		await shop.unsafe(`
			create table orders (id bigint primary key, "select" text, total numeric(10,2) not null default 0);
			create table audit_trail (at timestamptz, note text);
			create view big_orders as select id, total from orders where total > 100;
			create schema empty_one;
			analyze orders;
		`);
		await shop.end();
		h.deps.databaseEndpoint = () => target;
		await setEnv("POSTGRES_PASSWORD", "test");
		await setEnv("POSTGRES_DB", "shop");
	}, 90_000);
	afterAll(async () => {
		await h?.close();
	});

	test("returns schemas, tables, views and columns", async () => {
		const r = await schema();
		expect(r.status).toBe(200);
		expect(r.json.engine).toBe("postgres");
		expect(r.json.database).toBe("shop");
		const names = r.json.schemas.map((s: { name: string }) => s.name);
		expect(names).toContain("public");
		expect(names).toContain("empty_one");
		const pub = r.json.schemas.find(
			(s: { name: string }) => s.name === "public",
		);
		const byName = Object.fromEntries(
			pub.tables.map((t: { name: string }) => [t.name, t]),
		);
		expect(byName.orders).toMatchObject({
			kind: "table",
			editable: true,
			rows: 0,
			columns: [
				{
					name: "id",
					type: "bigint",
					nullable: false,
					primaryKey: true,
					default: null,
				},
				{ name: "select", type: "text", nullable: true, primaryKey: false },
				{
					name: "total",
					type: "numeric(10,2)",
					nullable: false,
					default: "0",
					primaryKey: false,
				},
			],
		});
		expect(byName.audit_trail).toMatchObject({
			kind: "table",
			editable: false,
			rows: null,
		});
		expect(byName.big_orders).toMatchObject({ kind: "view", editable: false });
		expect(
			byName.big_orders.columns.map((c: { name: string }) => c.name),
		).toEqual(["id", "total"]);
	});

	test("an unreachable database is a 409 that says why", async () => {
		h.deps.databaseEndpoint = () => ({ host: "127.0.0.1", port: 1 });
		try {
			const r = await schema();
			expect(r.status).toBe(409);
			expect(r.json.error.details.reason).toBe("unreachable");
			expect(r.json.error.message).toContain("redeploy");
		} finally {
			h.deps.databaseEndpoint = () => target;
		}
	});

	test("rotated credentials replace the pool; refused ones are a 409 auth", async () => {
		await setEnv("POSTGRES_PASSWORD", "wrong");
		const refused = await schema();
		expect(refused.status).toBe(409);
		expect(refused.json.error.details.reason).toBe("auth");
		await setEnv("POSTGRES_PASSWORD", "test");
		expect((await schema()).status).toBe(200);
	});

	test("only database services, only signed-in callers", async () => {
		const app = await h.call("POST", `/api/environments/${envId}/services`, {
			headers: { cookie },
			body: {
				name: "web",
				spec: {
					kind: "application",
					source: { type: "image", image: "nginx:1.27" },
					build: { type: "image" },
					ports: [{ target: 80, protocol: "tcp" }],
					replicas: 1,
					resources: {},
					placement: [],
				},
			},
		});
		expect((await schema(app.json.id)).status).toBe(400);
		expect((await schema(dbId, {})).status).toBe(401);
	});
});
