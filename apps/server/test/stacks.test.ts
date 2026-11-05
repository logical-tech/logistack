import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { service, stack } from "@logistack/db";
import { eq, sql } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const COMPOSE = `
services:
  web:
    image: ghcr.io/acme/web:1.2
    ports: ["3000"]
    environment:
      DATABASE_URL: postgres://app:\${DB_PASSWORD:-pw}@db:5432/app
    depends_on: [db]
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: pw
      POSTGRES_USER: app
      POSTGRES_DB: app
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata: {}
`;

describe.skipIf(!hasDocker)("stacks API", () => {
	let h: Harness;
	let cookie: string;
	let envId: string;
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "stk", label: "stk" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const project = await h.call("POST", "/api/projects", {
			...as(),
			body: { name: "Stacks" },
		});
		const envs = await h.call(
			"GET",
			`/api/projects/${project.json.id}/environments`,
			as(),
		);
		envId = envs.json[0].id;
	}, 60_000);
	afterAll(() => h?.close());

	let stackId: string;

	test("a compose file becomes one stack of services", async () => {
		const res = await h.call("POST", `/api/environments/${envId}/stacks`, {
			...as(),
			body: { name: "shop", composeYaml: COMPOSE },
		});
		expect(res.status).toBe(201);
		stackId = res.json.stackId;
		expect(
			res.json.services.map((s: { name: string; kind: string }) => [
				s.name,
				s.kind,
			]),
		).toEqual([
			["db", "database"],
			["web", "application"],
		]);
		const list = await h.call(
			"GET",
			`/api/environments/${envId}/services`,
			as(),
		);
		expect(list.json.map((s: { stackId: string | null }) => s.stackId)).toEqual(
			[stackId, stackId],
		);
		const stacks = await h.call(
			"GET",
			`/api/environments/${envId}/stacks`,
			as(),
		);
		expect(stacks.json).toMatchObject([
			{ id: stackId, name: "shop", source: "compose" },
		]);
	});

	test("detail carries the services, the pasted file and the masked effective compose", async () => {
		const res = await h.call("GET", `/api/stacks/${stackId}`, as());
		expect(res.status).toBe(200);
		expect(res.json.composeYaml).toBe(COMPOSE);
		expect(res.json.services).toHaveLength(2);
		expect(res.json.effectiveCompose).toContain("image: ghcr.io/acme/web:1.2");
		// The owner holds read:secrets; credentials are still stored as secret env vars.
		expect(res.json.composeHidden).toBe(false);
		expect(res.json.effectiveCompose).toContain("POSTGRES_PASSWORD: pw");
		const vars = await h.call(
			"GET",
			`/api/env-vars?scope=service&scopeId=${res.json.services.find((s: { slug: string }) => s.slug === "web").id}`,
			as(),
		);
		expect(
			vars.json.map((v: { key: string; isSecret: boolean }) => [
				v.key,
				v.isSecret,
			]),
		).toEqual([["DATABASE_URL", true]]);
	});

	test("unsupported compose is a 400 listing every reason, and nothing is written", async () => {
		const res = await h.call("POST", `/api/environments/${envId}/stacks`, {
			...as(),
			body: {
				name: "bad",
				composeYaml: "services:\n  app:\n    build: .\n    privileged: true\n",
			},
		});
		expect(res.status).toBe(400);
		expect(res.json.error.details.length).toBeGreaterThanOrEqual(2);
		const rows = await h.deps.db
			.select()
			.from(stack)
			.where(eq(stack.name, "bad"));
		expect(rows).toEqual([]);
	});

	test("taken service names are a 409", async () => {
		const res = await h.call("POST", `/api/environments/${envId}/stacks`, {
			...as(),
			body: { name: "shop-2", composeYaml: COMPOSE },
		});
		expect(res.status).toBe(409);
	});

	test("deleting the stack deletes its services", async () => {
		expect(
			(await h.call("DELETE", `/api/stacks/${stackId}`, as())).status,
		).toBe(204);
		const rows = await h.deps.db
			.select()
			.from(service)
			.where(eq(service.environmentId, envId));
		expect(rows).toEqual([]);
		expect((await h.call("GET", `/api/stacks/${stackId}`, as())).status).toBe(
			404,
		);
	});

	test("the migration groups services an earlier template deploy created", async () => {
		const legacy = (slug: string) => ({
			environmentId: envId,
			name: slug,
			slug,
			kind: "application" as const,
			spec: {
				kind: "application" as const,
				source: { type: "image" as const, image: "nginx:1.29" },
				build: { type: "image" as const },
				ports: [],
				replicas: 1,
				resources: {},
				placement: [],
			},
			importedFrom: `template:umami:analytics/${slug}`,
		});
		await h.deps.db.insert(service).values([legacy("app"), legacy("cache")]);
		const file = readFileSync(
			new URL("../../../packages/db/drizzle/0018_stack.sql", import.meta.url),
			"utf8",
		);
		const backfill = file.slice(file.indexOf("-- Backfill"));
		for (const statement of backfill.split("--> statement-breakpoint"))
			await h.deps.db.execute(sql.raw(statement));
		const [made] = await h.deps.db
			.select()
			.from(stack)
			.where(eq(stack.name, "analytics"));
		expect(made).toMatchObject({ source: "template", templateId: "umami" });
		const rows = await h.deps.db
			.select({ stackId: service.stackId })
			.from(service)
			.where(eq(service.environmentId, envId));
		const id = made?.id ?? null;
		expect(rows.map((r) => r.stackId)).toEqual([id, id]);
	});
});
