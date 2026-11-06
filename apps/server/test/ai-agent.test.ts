import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setPriceCatalog } from "../src/ai/catalog.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

type Msg = { role: string; content?: string | null; tool_call_id?: string };

/**
 * A fake model: with no tool result yet it lists projects; after that it asks to delete the
 * project named in the result; once the delete is answered it replies in text.
 */
function fakeModel() {
	const requests: { messages: Msg[]; tools?: unknown[] }[] = [];
	const call = (id: string, name: string, args: unknown) => ({
		choices: [
			{
				delta: {
					tool_calls: [
						{
							index: 0,
							id,
							function: { name, arguments: JSON.stringify(args) },
						},
					],
				},
			},
		],
	});
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (new URL(req.url).pathname === "/v1/models")
				return Response.json({ data: [{ id: "agent" }] });
			const body = (await req.json()) as (typeof requests)[number];
			requests.push(body);
			const tools = body.messages.filter((m) => m.role === "tool");
			const lastUser = body.messages.findLast((m) => m.role === "user");
			let chunks: unknown[];
			if (lastUser?.content === "hi")
				chunks = [{ choices: [{ delta: { content: "Hello!" } }] }];
			else if (tools.length === 0)
				chunks = [
					{ choices: [{ delta: { reasoning_content: "Look first." } }] },
					call("c1", "call_operation", { name: "get_projects" }),
				];
			else if (tools.length === 1) {
				const id = /"id":"(prj_[a-z0-9]+)"/.exec(tools[0]?.content ?? "")?.[1];
				chunks = [
					call("c2", "call_operation", {
						name: "project_delete",
						arguments: { id },
					}),
				];
			} else chunks = [{ choices: [{ delta: { content: "Done." } }] }];
			chunks.push({
				choices: [],
				usage: { prompt_tokens: 100, completion_tokens: 10 },
			});
			return new Response(
				`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	return { server, requests, url: `http://127.0.0.1:${server.port}/v1` };
}

describe.skipIf(!hasDocker)("AI agent", () => {
	let h: Harness;
	let cookie: string;
	let projectId: string;
	const model = fakeModel();
	const as = () => ({ headers: { cookie } });
	const detail = (id: string) =>
		h.call("GET", `/api/ai/agent/conversations/${id}`, as());
	/** Polls until the run leaves `running`. */
	const settled = async (id: string) => {
		for (let i = 0; i < 100; i++) {
			const d = await detail(id);
			if (d.json.conversation.status !== "running") return d.json;
			await Bun.sleep(50);
		}
		throw new Error("the run never settled");
	};

	beforeAll(async () => {
		setPriceCatalog({});
		h = await startHarness({ area: "ai-agent", label: "ai-agent" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		await h.call("PATCH", "/api/instance/settings", {
			...as(),
			body: { allowPrivateHosts: true },
		});
		await h.call("POST", "/api/ai/provider-keys", {
			...as(),
			body: { provider: "custom", label: "Fake", baseUrl: model.url },
		});
		const prj = await h.call("POST", "/api/projects", {
			...as(),
			body: { name: "Doomed" },
		});
		projectId = prj.json.id;
	});
	afterAll(async () => {
		model.server.stop(true);
		await h?.close();
	});

	test("answers through the gateway with the gateway switched off", async () => {
		const res = await h.call("POST", "/api/ai/agent/conversations", {
			...as(),
			body: { text: "hi", model: "custom/agent" },
		});
		expect(res.status).toBe(201);
		expect(res.json.title).toBe("hi");
		const d = await settled(res.json.id);
		expect(d.conversation.status).toBe("idle");
		expect(d.messages.map((m: { role: string }) => m.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(d.messages[1]).toMatchObject({
			parts: [{ type: "text", text: "Hello!" }],
			model: "custom/agent",
			inputTokens: 100,
			done: true,
		});
		// Billed to the member like any gateway call.
		const usage = await h.call("GET", "/api/ai/usage?range=24h", as());
		expect(usage.json.totals.free.requests + usage.json.totals.paid.requests).toBe(1);
	});

	test("runs operations as the member and waits for approval on destructive ones", async () => {
		const res = await h.call("POST", "/api/ai/agent/conversations", {
			...as(),
			body: { text: "delete the Doomed project", model: "custom/agent" },
		});
		const id = res.json.id;
		let d = await settled(id);
		expect(d.conversation.status).toBe("waiting");
		const [, listed, asked] = d.messages;
		expect(listed.parts[0]).toEqual({ type: "reasoning", text: "Look first." });
		expect(listed.parts[1]).toMatchObject({
			type: "dynamic-tool",
			toolName: "call_operation",
			state: "output-available",
		});
		expect(JSON.stringify(listed.parts[1].output)).toContain(projectId);
		expect(asked.parts[0]).toMatchObject({
			state: "approval-requested",
			approval: { id: "c2" },
			input: { name: "project_delete", arguments: { id: projectId } },
		});
		// Nothing was deleted yet.
		expect((await h.call("GET", `/api/projects/${projectId}`, as())).status).toBe(200);

		const ok = await h.call("POST", `/api/ai/agent/conversations/${id}/approvals`, {
			...as(),
			body: { toolCallId: "c2", approved: true },
		});
		expect(ok.status).toBe(202);
		d = await settled(id);
		expect(d.conversation.status).toBe("idle");
		expect(d.messages[2].parts[0].state).toBe("output-available");
		expect(d.messages.at(-1).parts).toEqual([{ type: "text", text: "Done." }]);
		expect((await h.call("GET", `/api/projects/${projectId}`, as())).status).toBe(404);
		// The model saw the tool catalog and every result.
		expect(model.requests.at(-1)?.tools).toHaveLength(3);
	});

	test("conversations are private to their member", async () => {
		const list = await h.call("GET", "/api/ai/agent/conversations", as());
		expect(list.json).toHaveLength(2);
		const other = await h.call(
			"GET",
			`/api/ai/agent/conversations/${list.json[0].id}`,
		);
		expect(other.status).toBe(401);
		const del = await h.call(
			"DELETE",
			`/api/ai/agent/conversations/${list.json[0].id}`,
			as(),
		);
		expect(del.status).toBe(204);
	});
});
