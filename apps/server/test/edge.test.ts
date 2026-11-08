import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { domain, serviceMaintenance } from "@logistack/db";
import { eq } from "drizzle-orm";
import { toolsFrom } from "../src/mcp.ts";
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
	resources: {},
	placement: [],
};

describe.skipIf(!hasDocker)("domain edge and service maintenance", () => {
	let h: Harness;
	let cookie: string;
	let serviceId: string;
	let domainId: string;
	const as = (extra: { body?: unknown } = {}) => ({
		headers: { cookie },
		...extra,
	});
	const off = { rateLimit: null, block: null, errorPage: null };

	beforeAll(async () => {
		h = await startHarness({ area: "edge", label: "edge" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const project = await h.call(
			"POST",
			"/api/projects",
			as({ body: { name: "Shop" } }),
		);
		const envs = await h.call(
			"GET",
			`/api/projects/${project.json.id}/environments`,
			as(),
		);
		const svc = await h.call(
			"POST",
			`/api/environments/${envs.json[0].id}/services`,
			as({ body: { name: "Web", spec: imageSpec } }),
		);
		serviceId = svc.json.id;
		const dom = await h.call(
			"POST",
			`/api/services/${serviceId}/domains`,
			as({
				body: {
					hostname: "edge.example.com",
					port: 80,
					https: true,
					cert: "auto",
				},
			}),
		);
		domainId = dom.json.id;
	}, 60_000);
	afterAll(async () => {
		await h?.close();
	});

	test("a new domain has every edge feature off", async () => {
		const res = await h.call("GET", `/api/domains/${domainId}/edge`, as());
		expect(res.json).toEqual(off);
	});

	test("edge settings are saved and read back; null turns a feature off", async () => {
		const body = {
			rateLimit: {
				requestsPerSecond: 10,
				burst: 20,
				exemptCidrs: ["10.0.0.0/8"],
			},
			block: { paths: ["/wp-admin*"], userAgents: ["sqlmap"] },
			errorPage: "<h1>Down</h1>",
		};
		const res = await h.call(
			"PUT",
			`/api/domains/${domainId}/edge`,
			as({ body }),
		);
		expect(res.status).toBe(200);
		expect(
			(await h.call("GET", `/api/domains/${domainId}/edge`, as())).json,
		).toEqual(body);
		await h.call("PUT", `/api/domains/${domainId}/edge`, as({ body: off }));
		const [row] = await h.deps.db
			.select()
			.from(domain)
			.where(eq(domain.id, domainId));
		expect(row?.edge).toEqual(off);
	});

	test("bad input is refused at the boundary", async () => {
		for (const body of [
			{ rateLimit: { requestsPerSecond: 10, burst: 5 } },
			{ rateLimit: { requestsPerSecond: 0, burst: 5 } },
			{ rateLimit: { requestsPerSecond: 1, burst: 1, exemptCidrs: ["nope"] } },
			{ block: { paths: ["no-slash"] } },
			{ errorPage: "x".repeat(70_000) },
		])
			expect(
				(await h.call("PUT", `/api/domains/${domainId}/edge`, as({ body })))
					.status,
			).toBe(400);
	});

	test("maintenance is off until turned on, then stored", async () => {
		const path = `/api/services/${serviceId}/maintenance`;
		expect((await h.call("GET", path, as())).json).toEqual({
			enabled: false,
			allowCidrs: [],
			message: null,
		});
		const body = {
			enabled: true,
			allowCidrs: ["203.0.113.0/24"],
			message: "Back soon",
		};
		expect((await h.call("PUT", path, as({ body }))).json).toEqual(body);
		const [row] = await h.deps.db
			.select()
			.from(serviceMaintenance)
			.where(eq(serviceMaintenance.serviceId, serviceId));
		expect(row?.settings).toEqual(body);
		expect(
			(
				await h.call(
					"PUT",
					path,
					as({ body: { enabled: true, allowCidrs: ["x"] } }),
				)
			).status,
		).toBe(400);
	});

	test("both are MCP tools", async () => {
		const doc = await h.call("GET", "/api/openapi.json");
		const names = toolsFrom(doc.json).map((t) => t.name);
		expect(names).toContain("domain_edge");
		expect(names).toContain("service_maintenance");
	});
});
