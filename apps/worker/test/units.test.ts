import { describe, expect, test } from "bun:test";
import type { Task } from "@logistack/docker";
import { buildPlan } from "../src/build.ts";
import type { DomainRow } from "../src/load.ts";
import { domainRoute, routeAccess } from "../src/proxy.ts";
import { observe } from "../src/reconcile.ts";

describe("buildPlan", () => {
	const base = {
		dir: "/w/builds/dep_1",
		appPath: "apps/web",
		imageRef: "ls-local/org/ls-svc-a:dep_1",
		railpackFrontend: "ghcr.io/railwayapp/railpack-frontend:v1",
		buildEnv: [
			{ key: "PUBLIC_URL", value: "https://x", isSecret: false },
			{ key: "NPM_TOKEN", value: "t0ken", isSecret: true },
		],
		context: { LOGISTACK_DEPLOYMENT_ID: "dep_1", LOGISTACK_COMMIT_SHA: "abc" },
	};

	test("dockerfile build: paths resolve inside the checkout, secrets go through env", () => {
		const plan = buildPlan({
			...base,
			build: {
				type: "dockerfile",
				dockerfilePath: "docker/Dockerfile.prod",
				context: ".",
				target: "runtime",
			},
		});
		expect(plan.args).toEqual([
			"build",
			"--progress",
			"plain",
			"--frontend",
			"dockerfile.v0",
			"--local",
			"context=/w/builds/dep_1/apps/web",
			"--local",
			"dockerfile=/w/builds/dep_1/apps/web/docker",
			"--opt",
			"filename=Dockerfile.prod",
			"--opt",
			"target=runtime",
			"--secret",
			"id=NPM_TOKEN,env=NPM_TOKEN",
			"--opt",
			"build-arg:PUBLIC_URL=https://x",
			"--opt",
			"build-arg:LOGISTACK_COMMIT_SHA=abc",
			"--opt",
			"build-arg:LOGISTACK_DEPLOYMENT_ID=dep_1",
			"--output",
			"type=docker,name=ls-local/org/ls-svc-a:dep_1",
		]);
		expect(plan.env).toEqual({ NPM_TOKEN: "t0ken" });
		expect(plan.args.join(" ")).not.toContain("t0ken");
	});

	test("paths escaping the checkout are rejected", () => {
		expect(() =>
			buildPlan({
				...base,
				build: {
					type: "dockerfile",
					dockerfilePath: "Dockerfile",
					context: "../../..",
				},
			}),
		).toThrow(/escapes the repository/);
	});

	test("railpack prepares a plan, then builds it with the railpack frontend", () => {
		const plan = buildPlan({
			...base,
			buildEnv: [],
			build: { type: "railpack" },
		});
		expect(plan.prepare).toEqual([
			"prepare",
			"/w/builds/dep_1/apps/web",
			"--plan-out",
			"/w/builds/dep_1/apps/web/railpack-plan.json",
		]);
		expect(plan.args).toContain(
			"source=ghcr.io/railwayapp/railpack-frontend:v1",
		);
		expect(plan.args).toContain("filename=railpack-plan.json");
		// The railpack frontend reads its plan, not Dockerfile ARGs.
		expect(plan.args.join(" ")).not.toContain("LOGISTACK_");
	});
});

describe("observe", () => {
	const task = (
		state: Task["Status"]["State"],
		desired: Task["DesiredState"] = "running",
	) => ({
		DesiredState: desired,
		Status: { State: state, Timestamp: "", Message: "" },
	});

	test("maps task states to the observed state", () => {
		expect(observe({ exists: false, desired: 1, tasks: [] }).observed).toBe(
			"unknown",
		);
		expect(observe({ exists: true, desired: 0, tasks: [] }).observed).toBe(
			"stopped",
		);
		expect(
			observe({
				exists: true,
				desired: 2,
				tasks: [task("running"), task("running")],
			}),
		).toEqual({ observed: "running", running: 2 });
		expect(
			observe({
				exists: true,
				desired: 2,
				tasks: [task("running"), task("starting")],
			}).observed,
		).toBe("starting");
		expect(
			observe({
				exists: true,
				desired: 1,
				tasks: [task("failed", "shutdown")],
				updateState: "rollback_paused",
			}).observed,
		).toBe("unhealthy");
		expect(
			observe({ exists: true, desired: 1, tasks: [task("failed", "shutdown")] })
				.observed,
		).toBe("failed");
	});
});

describe("domainRoute", () => {
	const d = {
		id: "dom_1",
		serviceId: "svc_1",
		hostname: "app.example.com",
		port: 8080,
		pathPrefix: null,
		https: true,
		cert: "auto",
		customCertificateId: null,
		redirectTo: null,
		dnsProviderId: null,
	} as DomainRow;

	test("auto HTTPS route to the service by its Docker name", () => {
		expect(domainRoute(d, "ls-svc-1", {})).toEqual({
			ok: true,
			route: {
				domainId: "dom_1",
				hostname: "app.example.com",
				upstream: { host: "ls-svc-1", port: 8080 },
				https: true,
				cert: "auto",
			},
		});
	});

	test("wildcard without DNS provider is a domain error, not a broken sync", () => {
		expect(
			domainRoute({ ...d, hostname: "*.example.com" }, "ls-svc-1", {}),
		).toEqual({
			ok: false,
			error: "a wildcard domain needs a DNS provider",
		});
	});

	test("plain HTTP and redirects", () => {
		const r = domainRoute(
			{ ...d, https: false, redirectTo: "www.example.com" },
			"h",
			{},
		);
		expect(r).toMatchObject({
			ok: true,
			route: {
				https: false,
				cert: "none",
				redirectTo: "https://www.example.com",
			},
		});
	});
});

describe("routeAccess", () => {
	const ip = { type: "ip_allow" as const, cidrs: ["10.0.0.0/8"] };
	const svc = [
		{ username: "ops", hash: "svc-ops" },
		{ username: "ci", hash: "svc-ci" },
	];

	test("no service basic auth leaves the domain's rules as they are", () => {
		expect(routeAccess([ip], null)).toEqual([ip]);
		expect(routeAccess([], [])).toEqual([]);
	});

	test("service basic auth alone protects every domain of the service", () => {
		expect(routeAccess([ip], svc)).toEqual([
			ip,
			{ type: "basic_auth", users: svc },
		]);
	});

	test("domain and service users merge into one check, the domain's entry winning", () => {
		const own = {
			type: "basic_auth" as const,
			users: [
				{ username: "ops", hash: "dom-ops" },
				{ username: "qa", hash: "dom-qa" },
			],
		};
		expect(routeAccess([own, ip], svc)).toEqual([
			ip,
			{
				type: "basic_auth",
				users: [
					{ username: "ops", hash: "dom-ops" },
					{ username: "qa", hash: "dom-qa" },
					{ username: "ci", hash: "svc-ci" },
				],
			},
		]);
	});
});
