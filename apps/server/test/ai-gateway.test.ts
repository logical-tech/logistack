import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setPriceCatalog } from "../src/ai/catalog.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

/** A fake OpenAI-compatible server: `busy` always rate-limits, `ok` answers with usage. */
function fakeUpstream() {
	const calls: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/v1/models")
				return Response.json({ data: [{ id: "busy" }, { id: "ok" }] });
			const body = (await req.json()) as {
				model: string;
				stream?: boolean;
				stream_options?: { include_usage?: boolean };
			};
			calls.push(body.model);
			if (body.model === "busy")
				return Response.json(
					{ error: { message: "slow down" } },
					{ status: 429, headers: { "retry-after": "120" } },
				);
			const usage = { prompt_tokens: 1000, completion_tokens: 500 };
			if (!body.stream)
				return Response.json({
					id: "c1",
					choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
					usage,
				});
			const chunks = [
				{ choices: [{ delta: { content: "hel" } }] },
				{ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
				...(body.stream_options?.include_usage ? [{ choices: [], usage }] : []),
			];
			return new Response(
				`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	return { server, calls, url: `http://127.0.0.1:${server.port}/v1` };
}

describe.skipIf(!hasDocker)("AI gateway", () => {
	let h: Harness;
	let cookie: string;
	let key: string;
	const upstream = fakeUpstream();
	const as = () => ({ headers: { cookie } });
	const gw = (extra: Record<string, string> = {}) => ({
		headers: { authorization: `Bearer ${key}`, ...extra },
	});

	beforeAll(async () => {
		// $1 / $2 per million tokens for the model the fake upstream serves.
		setPriceCatalog({
			acme: { models: { ok: { cost: { input: 1, output: 2 } } } },
		});
		h = await startHarness({ area: "ai", label: "ai" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		await h.call("PATCH", "/api/instance/settings", {
			...as(),
			body: { allowPrivateHosts: true },
		});
	});
	afterAll(async () => {
		upstream.server.stop(true);
		await h?.close();
	});

	test("a provider key is tested and lists its models", async () => {
		const res = await h.call("POST", "/api/ai/provider-keys", {
			...as(),
			body: { provider: "custom", label: "Local", baseUrl: upstream.url },
		});
		expect(res.status).toBe(201);
		expect(res.json.status).toBe("healthy");
		expect(res.json.models).toEqual(["busy", "ok"]);
		expect(JSON.stringify(res.json)).not.toContain("secret");
	});

	test("keys are refused while the gateway is off", async () => {
		const created = await h.call("POST", "/api/ai/gateway-keys", {
			...as(),
			body: { name: "laptop" },
		});
		expect(created.status).toBe(201);
		key = created.json.key;
		expect(key.startsWith("lsai_")).toBe(true);
		const off = await h.call("GET", "/v1/models", gw());
		expect(off.status).toBe(403);
		await h.call("PUT", "/api/ai/settings", {
			...as(),
			body: { gatewayEnabled: true, autoChain: ["custom/busy", "custom/ok"] },
		});
		const models = await h.call("GET", "/v1/models", gw());
		expect(models.json.data.map((m: { id: string }) => m.id)).toEqual([
			"auto",
			"custom/busy",
			"custom/ok",
		]);
	});

	test("auto falls back past a rate-limited model and bills the call", async () => {
		const res = await h.call("POST", "/v1/chat/completions", {
			...gw(),
			body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
		});
		expect(res.status).toBe(200);
		expect(res.json.choices[0].message.content).toBe("hello");
		expect(res.headers.get("x-logistack-route")).toBe("custom/ok");
		expect(upstream.calls).toEqual(["busy", "ok"]);

		// The 429 cooled `busy` down: the next call goes straight to `ok`.
		await h.call("POST", "/v1/chat/completions", {
			...gw(),
			body: { model: "auto", messages: [{ role: "user", content: "again" }] },
		});
		expect(upstream.calls).toEqual(["busy", "ok", "ok"]);

		const usage = await h.call("GET", "/api/ai/usage?range=24h", as());
		expect(usage.json.totals.free.requests).toBe(2);
		expect(usage.json.totals.free.inputTokens).toBe(2000);
		// 1000 in at $1/M + 500 out at $2/M = $0.002 per call.
		expect(usage.json.totals.free.cost).toBeCloseTo(0.004, 6);
		expect(usage.json.byModel[0]).toMatchObject({
			provider: "custom",
			model: "ok",
		});
	});

	test("Anthropic clients get Messages events from a chat upstream", async () => {
		const res = await h.app.request("/v1/messages", {
			method: "POST",
			headers: { "x-api-key": key, "content-type": "application/json" },
			body: JSON.stringify({
				model: "custom/ok",
				max_tokens: 50,
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		const types = [...text.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
		expect(types[0]).toBe("message_start");
		expect(types.at(-1)).toBe("message_stop");
		expect(text).toContain('"text":"hel"');
		expect(text).toContain('"output_tokens":500');
	});

	test("Responses clients get a translated response", async () => {
		const res = await h.call("POST", "/v1/responses", {
			...gw(),
			body: { model: "custom/ok", input: "hi" },
		});
		expect(res.status).toBe(200);
		expect(res.json.object).toBe("response");
		expect(res.json.output[0].content[0].text).toBe("hello");
	});

	test("a member over the free cap is refused", async () => {
		const me = await h.call("GET", "/api/ai/settings", as());
		const userId = (await h.call("GET", "/api/ai/budgets", as())).json.find(
			(b: { email: string }) => b.email === owner.email,
		).userId;
		expect(me.json.me.caps.free).toBeNull();
		await h.call("PUT", `/api/ai/budgets/${userId}`, {
			...as(),
			body: { free: 0.001, paid: 0 },
		});
		const refused = await h.call("POST", "/v1/chat/completions", {
			...gw(),
			body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
		});
		expect(refused.status).toBe(429);
		expect(refused.json.error.code).toBe("quota_exceeded");
	});

	test("unknown keys are rejected in the client's dialect", async () => {
		const res = await h.call("POST", "/v1/messages", {
			headers: { "x-api-key": "lsai_nope" },
			body: { model: "auto", messages: [{ role: "user", content: "x" }] },
		});
		expect(res.status).toBe(401);
		expect(res.json.type).toBe("error");
		expect(res.json.error.type).toBe("authentication_error");
	});
});
