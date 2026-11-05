import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, domain } from "@logistack/db";
import { eq } from "drizzle-orm";
import { toolsFrom } from "../src/mcp.ts";
import { probeOutcome } from "../src/routes/domain-access.ts";
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

test("forward-auth probe outcomes", () => {
	expect(probeOutcome(200).outcome).toBe("open");
	expect(probeOutcome(401).outcome).toBe("protected");
	expect(probeOutcome(302).outcome).toBe("protected");
	expect(probeOutcome(404).outcome).toBe("error");
	expect(probeOutcome(502).outcome).toBe("error");
});

describe.skipIf(!hasDocker)("domain access rules", () => {
	let h: Harness;
	let cookie: string;
	let serviceId: string;
	let domainId: string;
	const as = (extra: { body?: unknown } = {}) => ({
		headers: { cookie },
		...extra,
	});
	const put = (rules: unknown[], id = domainId) =>
		h.call("PUT", `/api/domains/${id}/access`, as({ body: { rules } }));
	const stored = async (id = domainId) =>
		(await h.deps.db.select().from(domain).where(eq(domain.id, id)))[0]?.access;

	beforeAll(async () => {
		h = await startHarness({ area: "qw49", label: "qw49" });
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
					hostname: "staging.example.com",
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

	test("rules are saved, hashed, and returned without hashes or passwords", async () => {
		const res = await put([
			{
				type: "basic_auth",
				users: [{ username: "ops", password: "hunter2-hunter2" }],
			},
			{ type: "ip_allow", cidrs: ["203.0.113.0/24", "2001:db8::/32"] },
			{
				type: "forward_auth",
				url: "https://auth.example.com/verify",
				copyHeaders: ["Remote-User"],
			},
		]);
		expect(res.status).toBe(200);
		const text = JSON.stringify(res.json);
		expect(text).not.toContain("hunter2");
		expect(text).not.toContain("$2");
		expect(res.json.rules[0]).toEqual({
			type: "basic_auth",
			users: [{ username: "ops" }],
		});
		const rule = (await stored())?.find((r) => r.type === "basic_auth");
		const hash = rule?.type === "basic_auth" ? rule.users[0]?.hash : "";
		expect(hash).toStartWith("$2");
		expect(await Bun.password.verify("hunter2-hunter2", hash ?? "")).toBe(true);

		const get = await h.call("GET", `/api/domains/${domainId}/access`, as());
		expect(get.json).toEqual(res.json);
		for (const path of [`/api/services/${serviceId}/domains`, "/api/domains"]) {
			const list = await h.call("GET", path, as());
			expect(JSON.stringify(list.json)).not.toContain("$2");
		}
		const listed = await h.call("GET", "/api/domains", as());
		expect(listed.json[0].access).toEqual([
			"basic_auth",
			"ip_allow",
			"forward_auth",
		]);
		const [audit] = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "domain.access"));
		expect(JSON.stringify(audit?.diff)).not.toContain("hunter2");
	});

	test("a user sent without a password keeps its hash; a new one needs a password", async () => {
		const before = JSON.stringify(await stored());
		const kept = await put([
			{ type: "basic_auth", users: [{ username: "ops" }] },
		]);
		expect(kept.status).toBe(200);
		expect(JSON.stringify(await stored())).toContain(
			JSON.parse(before).find((r: { type: string }) => r.type === "basic_auth")
				.users[0].hash,
		);
		const missing = await put([
			{ type: "basic_auth", users: [{ username: "new" }] },
		]);
		expect(missing.status).toBe(400);
		expect(missing.json.error.message).toContain("needs a password");
	});

	test("bad input is refused at the boundary", async () => {
		for (const rules of [
			[{ type: "ip_allow", cidrs: ["10.0.0.0/33"] }],
			[{ type: "ip_allow", cidrs: [] }],
			[{ type: "forward_auth", url: "ftp://x.example.com", copyHeaders: [] }],
			[
				{
					type: "forward_auth",
					url: "https://a.example.com",
					copyHeaders: ["Bad Header"],
				},
			],
			[
				{ type: "ip_allow", cidrs: ["10.0.0.1"] },
				{ type: "ip_allow", cidrs: ["10.0.0.2"] },
			],
			[
				{
					type: "basic_auth",
					users: [
						{ username: "a", password: "12345678" },
						{ username: "a", password: "12345678" },
					],
				},
			],
		])
			expect((await put(rules)).status).toBe(400);
	});

	test("an empty list removes every rule", async () => {
		expect((await put([])).json).toEqual({ rules: [] });
		expect(await stored()).toEqual([]);
	});

	test("redirect domains take no rules", async () => {
		const dom = await h.call(
			"POST",
			`/api/services/${serviceId}/domains`,
			as({
				body: {
					hostname: "www.example.com",
					port: 80,
					https: true,
					cert: "auto",
					redirectTo: "staging.example.com",
				},
			}),
		);
		const res = await put(
			[{ type: "ip_allow", cidrs: ["10.0.0.0/8"] }],
			dom.json.id,
		);
		expect(res.status).toBe(400);
		expect(res.json.error.message).toContain("redirect");
	});

	test("the forward-auth probe reports a refused private address", async () => {
		const res = await h.call(
			"POST",
			`/api/domains/${domainId}/access/forward-auth-test`,
			as({ body: { url: "http://127.0.0.1:9/verify" } }),
		);
		expect(res.status).toBe(200);
		expect(res.json.outcome).toBe("error");
		expect(res.json.message).toContain("private address");
	});

	test("the OpenAPI document carries the routes the MCP server is built from", async () => {
		const doc = await h.call("GET", "/api/openapi.json");
		const paths = Object.keys(doc.json.paths ?? {});
		expect(paths).toContain("/api/domains/{id}/access");
		expect(paths).toContain("/api/domains/{id}/access/forward-auth-test");
		const tools = toolsFrom(doc.json).filter((t) =>
			t.path.startsWith("/domains/{id}/access"),
		);
		expect(tools.map((t) => t.name).sort()).toEqual([
			"domain_access",
			"domain_forward_auth_test",
			"get_domains_by_id_access",
		]);
		for (const t of tools) {
			const required = (t.inputSchema.required ?? []) as string[];
			expect(new Set(required).size).toBe(required.length);
		}
	});
});
