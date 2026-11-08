import { describe, expect, test } from "bun:test";
import { ManifestEnvironment, ProjectManifest } from "@logistack/contracts";
import {
	planEnvironment,
	planProject,
	serviceVariables,
} from "../src/manifest-plan.ts";

const env = (services: unknown[], variables: unknown[] = []) =>
	ManifestEnvironment.parse({
		name: "Production",
		slug: "production",
		kind: "production",
		variables,
		services,
	});

const web = (variables: unknown[] = [], extra: object = {}) => ({
	name: "web",
	slug: "web",
	spec: {
		kind: "application",
		source: { type: "image", image: "nginx:1.27" },
		build: { type: "image" },
		ports: [],
		replicas: 1,
		resources: {},
		placement: [],
	},
	variables,
	domains: [
		{ hostname: "web.example.com", port: 80, https: true, cert: "auto" },
	],
	...extra,
});
const db = {
	name: "db",
	slug: "db",
	spec: {
		kind: "database",
		engine: "postgres",
		version: "17",
		credentialsRef: "env",
		resources: {},
	},
	variables: [{ key: "POSTGRES_PASSWORD", secret: true }],
	backups: [
		{
			target: "database",
			destination: "s3",
			cron: "0 3 * * *",
			retention: { count: 7 },
		},
	],
};

const ops = (plan: ReturnType<typeof planEnvironment>) =>
	plan.steps.map((s) => `${s.op} ${s.resource} ${s.name}`);

describe("planEnvironment", () => {
	test("an environment's own state plans nothing", () => {
		const have = env(
			[web([{ key: "API_KEY", value: "k", secret: true }]), db],
			[{ key: "TZ", value: "UTC" }],
		);
		expect(planEnvironment(have, have, true)).toEqual({
			steps: [],
			warnings: [],
		});
	});

	test("into an empty environment everything is created, in phase order", () => {
		const want = env([web(), db], [{ key: "TZ", value: "UTC" }]);
		expect(ops(planEnvironment(undefined, want, false))).toEqual([
			"create variable TZ",
			"create service web",
			"create service db",
			"create domain web.example.com",
			"create backup database s3 0 3 * * *",
		]);
	});

	test("a minted credential needs no value; any other new secret is a warning, not a step", () => {
		const want = env([web([{ key: "API_KEY", secret: true }]), db]);
		const plan = planEnvironment(undefined, want, false);
		expect(plan.warnings).toEqual([
			"production/web: secret API_KEY has no value in the manifest; set it after applying",
		]);
	});

	test("a secret without a value keeps the stored one; a changed one never shows its value", () => {
		const have = env([web([{ key: "API_KEY", value: "old", secret: true }])]);
		expect(
			planEnvironment(
				have,
				env([web([{ key: "API_KEY", secret: true }])]),
				false,
			).steps,
		).toEqual([]);
		const plan = planEnvironment(
			have,
			env([web([{ key: "API_KEY", value: "new", secret: true }])]),
			false,
		);
		expect(plan.steps.map((s) => s.changes)).toEqual([
			["variable API_KEY value changed"],
		]);
		expect(JSON.stringify(plan.steps.map((s) => s.changes))).not.toContain(
			"new",
		);
	});

	test("nothing is deleted without prune", () => {
		const have = env(
			[web([{ key: "EXTRA", value: "1" }]), db],
			[{ key: "TZ", value: "UTC" }],
		);
		const want = env([web([], { domains: [] })]);
		expect(planEnvironment(have, want, false).steps).toEqual([]);
		expect(ops(planEnvironment(have, want, true))).toEqual([
			"delete variable TZ",
			"update service web",
			"delete service db",
			"delete domain web.example.com",
		]);
	});

	test("without prune a service keeps variables the manifest does not list", () => {
		const have = [
			{ key: "A", value: "1", secret: false, buildTime: false },
			{ key: "B", value: "2", secret: true, buildTime: false },
		];
		const want = [{ key: "A", value: "1", secret: false, buildTime: false }];
		expect(serviceVariables(have, want, false)).toEqual({
			body: [
				{ key: "A", value: "1", isSecret: false, isBuildTime: false },
				{ key: "B", isSecret: true, isBuildTime: false },
			],
			lines: [],
		});
		expect(serviceVariables(have, want, true).lines).toEqual([
			"variable B removed",
		]);
	});

	test("an icon the manifest leaves out is not a change", () => {
		const have = env([web([], { icon: "nginx" })]);
		expect(planEnvironment(have, env([web()]), false).steps).toEqual([]);
	});
});

describe("planProject", () => {
	const project = (environments: unknown[]) =>
		ProjectManifest.parse({
			version: 1,
			kind: "project",
			project: { name: "Shop" },
			environments,
		});
	const staging = {
		name: "Staging",
		slug: "staging",
		kind: "staging",
		services: [],
	};

	test("a missing environment is created; an extra one is deleted only with prune", () => {
		const have = project([staging]);
		const want = project([
			{
				name: "Production",
				slug: "production",
				kind: "production",
				services: [web()],
			},
		]);
		expect(ops(planProject(have, want, false))).toEqual([
			"create environment production",
			"create service web",
			"create domain web.example.com",
		]);
		expect(ops(planProject(have, want, true))[1]).toBe(
			"delete environment staging",
		);
	});
});

describe("secret references", () => {
	const ref = (key: string, scope?: string, extra: object = {}) => ({
		key: "DB_PASSWORD",
		secretRef: { key, ...(scope && { scope }) },
		...extra,
	});
	const vars = (v: unknown[]) => env([web(v)]).services[0]?.variables ?? [];

	test("a reference needs no value, never warns, and is sent by name", () => {
		const plan = planEnvironment(
			env([web()]),
			env([web([ref("PG_PASSWORD", "organization", { asFile: true })])]),
			false,
		);
		expect(plan.warnings).toEqual([]);
		const { body, lines } = serviceVariables(
			[],
			vars([ref("PG_PASSWORD")]),
			false,
		);
		expect(lines).toEqual(["variable DB_PASSWORD added"]);
		expect(body).toEqual([
			{
				key: "DB_PASSWORD",
				isSecret: true,
				isBuildTime: false,
				secretRef: { key: "PG_PASSWORD" },
				asFile: false,
			},
		]);
	});

	test("the same reference is no change; another key, scope or file mode is", () => {
		const have = vars([ref("PG_PASSWORD", "organization", { secret: true })]);
		expect(
			serviceVariables(have, vars([ref("PG_PASSWORD")]), false).lines,
		).toEqual([]);
		expect(
			serviceVariables(
				have,
				vars([ref("PG_PASSWORD", "organization", { secret: true })]),
				false,
			).lines,
		).toEqual([]);
		expect(
			serviceVariables(have, vars([ref("PG_PASSWORD", "project")]), false)
				.lines,
		).toEqual(["variable DB_PASSWORD now references PG_PASSWORD@project"]);
		expect(
			serviceVariables(
				have,
				vars([ref("PG_PASSWORD", undefined, { asFile: true })]),
				false,
			).lines,
		).toEqual(["variable DB_PASSWORD now a file"]);
	});

	test("an environment variable cannot reference a secret", () => {
		const plan = planEnvironment(env([]), env([], [ref("PG_PASSWORD")]), false);
		expect(plan.steps).toEqual([]);
		expect(plan.warnings[0]).toContain(
			"references belong to service variables",
		);
	});

	test("a manifest refuses a reference with a value, and a plain file", () => {
		expect(() => vars([{ ...ref("X"), value: "v" }])).toThrow(
			"carries no value",
		);
		expect(() => vars([{ key: "A", value: "v", asFile: true }])).toThrow(
			"only a secret",
		);
	});
});
