import { describe, expect, test } from "bun:test";
import {
	AnthropicStreamEncoder,
	aiProvider,
	anthropicToChat,
	backoffSeconds,
	chatToAnthropic,
	chatToResponses,
	classifyFailure,
	costMicros,
	dailyAllowance,
	normalizeModelId,
	parseModelRef,
	priceFor,
	ResponsesStreamEncoder,
	responsesToChat,
	SseLines,
	servedModels,
	upstreamAuth,
} from "../src/index.ts";

const events = (lines: string[]) =>
	lines.map((l) => JSON.parse(l.split("\ndata: ")[1] ?? "{}"));

describe("model refs", () => {
	test("auto, pinned and bare ids", () => {
		expect(parseModelRef("auto")).toEqual({ kind: "auto" });
		expect(parseModelRef("groq/llama-3.3-70b-versatile")).toEqual({
			kind: "pinned",
			provider: "groq",
			model: "llama-3.3-70b-versatile",
		});
		// A slash that is not a provider stays part of the model id.
		expect(parseModelRef("meta/llama-3.3-70b-instruct")).toEqual({
			kind: "any",
			model: "meta/llama-3.3-70b-instruct",
		});
		expect(parseModelRef("openrouter/meta-llama/llama-3.3-70b:free")).toEqual({
			kind: "pinned",
			provider: "openrouter",
			model: "meta-llama/llama-3.3-70b:free",
		});
	});

	test("OpenRouter serves only free models", () => {
		const p = aiProvider("openrouter");
		if (!p) throw new Error("missing");
		expect(servedModels(p, ["a/b", "a/c:free"])).toEqual(["a/c:free"]);
	});

	test("Cloudflare keys carry the account", () => {
		const p = aiProvider("cloudflare");
		if (!p) throw new Error("missing");
		const { baseUrl, headers } = upstreamAuth(p, "acc123:tok");
		expect(baseUrl).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1",
		);
		expect(headers.authorization).toBe("Bearer tok");
	});
});

describe("pricing", () => {
	const catalog = {
		groq: {
			models: {
				"llama-3.3-70b-versatile": { cost: { input: 0.59, output: 0.79 } },
			},
		},
		together: {
			models: {
				"meta-llama/Llama-3.3-70B-Instruct-Turbo": {
					cost: { input: 0.88, output: 0.88 },
				},
			},
		},
		deepinfra: {
			models: {
				"meta-llama/Llama-3.3-70B-Instruct": {
					cost: { input: 0.23, output: 0.4 },
				},
			},
		},
		openai: {
			models: {
				"gpt-5": { cost: { input: 1.25, output: 10, cache_read: 0.125 } },
			},
		},
		nvidia: {
			models: {
				"meta/llama-3.3-70b-instruct": { cost: { input: 0, output: 0 } },
			},
		},
	};

	test("normalizes spellings", () => {
		expect(normalizeModelId("meta/Llama-3.3-70B-Instruct")).toBe(
			"llama-3.3-70b",
		);
		expect(normalizeModelId("llama-3.3-70b-versatile")).toBe("llama-3.3-70b");
		expect(normalizeModelId("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe(
			"llama-3.3-70b",
		);
		expect(normalizeModelId("meta-llama/llama-3.3-70b-instruct:free")).toBe(
			"llama-3.3-70b",
		);
	});

	test("own price first, else the cheapest market price", () => {
		expect(priceFor(catalog, "groq", "llama-3.3-70b-versatile")?.input).toBe(
			0.59,
		);
		// Listed at zero on its own provider: priced at the market.
		expect(
			priceFor(catalog, "nvidia", "meta/llama-3.3-70b-instruct")?.input,
		).toBe(0.23);
		expect(priceFor(catalog, "openai", "unknown-model")).toBeUndefined();
	});

	test("cost in micro-dollars with cached input", () => {
		const p = priceFor(catalog, "openai", "gpt-5");
		// 1M fresh input = $1.25, 1M output = $10.
		expect(costMicros(p, { input: 1_000_000, output: 0, cached: 0 })).toBe(
			1_250_000,
		);
		expect(costMicros(p, { input: 1_000, output: 1_000, cached: 1_000 })).toBe(
			10_125,
		);
		expect(costMicros(undefined, { input: 5, output: 5, cached: 0 })).toBe(0);
	});
});

describe("Anthropic front door", () => {
	test("request with system, tools and tool results", () => {
		const chat = anthropicToChat({
			model: "auto",
			max_tokens: 100,
			system: [{ type: "text", text: "Be brief." }],
			tools: [{ name: "weather", input_schema: { type: "object" } }],
			tool_choice: { type: "any" },
			messages: [
				{ role: "user", content: "Rome?" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "weather",
							input: { city: "Rome" },
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "t1", content: "sunny" },
					],
				},
			],
		});
		expect(chat.messages).toEqual([
			{ role: "system", content: "Be brief." },
			{ role: "user", content: "Rome?" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "t1",
						type: "function",
						function: { name: "weather", arguments: '{"city":"Rome"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "t1", content: "sunny" },
		]);
		expect(chat.tool_choice).toBe("required");
		expect(chat.tools?.[0]?.function.name).toBe("weather");
	});

	test("response with a tool call", () => {
		const msg = chatToAnthropic(
			{
				choices: [
					{
						message: {
							content: "Checking",
							tool_calls: [
								{
									id: "c1",
									type: "function",
									function: { name: "w", arguments: '{"a":1}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			},
			"m",
		);
		expect(msg.stop_reason).toBe("tool_use");
		expect(msg.content).toEqual([
			{ type: "text", text: "Checking" },
			{ type: "tool_use", id: "c1", name: "w", input: { a: 1 } },
		]);
		expect(msg.usage.input_tokens).toBe(10);
	});

	test("stream of text then a tool call", () => {
		const enc = new AnthropicStreamEncoder("m");
		const out = [
			...enc.push({ choices: [{ delta: { content: "Hi" } }] }),
			...enc.push({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "c1",
									function: { name: "w", arguments: '{"a"' },
								},
							],
						},
					},
				],
			}),
			...enc.push({
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, function: { arguments: ":1}" } }],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
			...enc.push({
				choices: [],
				usage: { prompt_tokens: 3, completion_tokens: 4 },
			}),
			...enc.finish(),
		];
		expect(events(out).map((e) => e.type)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		const delta = events(out).at(-2);
		expect(delta.delta.stop_reason).toBe("tool_use");
		expect(delta.usage.output_tokens).toBe(4);
	});
});

describe("Responses front door", () => {
	test("request items to chat messages", () => {
		const chat = responsesToChat({
			model: "auto",
			instructions: "Sys",
			input: [
				{ role: "user", content: [{ type: "input_text", text: "Hi" }] },
				{ type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
				{ type: "function_call", call_id: "c2", name: "g", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "ok" },
			],
			tools: [
				{ type: "function", name: "f", parameters: {} },
				{ type: "web_search" },
			],
			max_output_tokens: 50,
		});
		expect(chat.messages.map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
		]);
		const assistant = chat.messages[2];
		expect(
			assistant?.role === "assistant" && assistant.tool_calls?.length,
		).toBe(2);
		expect(chat.tools?.length).toBe(1);
		expect(chat.max_tokens).toBe(50);
	});

	test("response output items", () => {
		const r = chatToResponses(
			{
				choices: [{ message: { content: "Yo" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 2, completion_tokens: 1 },
			},
			"m",
		);
		expect(r.status).toBe("completed");
		expect(r.output).toHaveLength(1);
		expect(r.usage.total_tokens).toBe(3);
	});

	test("stream events end with response.completed", () => {
		const enc = new ResponsesStreamEncoder("m");
		const out = [
			...enc.push({ choices: [{ delta: { content: "A" } }] }),
			...enc.push({
				choices: [{ delta: { content: "B" }, finish_reason: "stop" }],
			}),
			...enc.finish(),
		];
		const ev = events(out);
		expect(ev.map((e) => e.type)).toEqual([
			"response.created",
			"response.output_item.added",
			"response.content_part.added",
			"response.output_text.delta",
			"response.output_text.delta",
			"response.output_text.done",
			"response.output_item.done",
			"response.completed",
		]);
		expect(ev.at(-1).response.output[0].content[0].text).toBe("AB");
		expect(ev.map((e) => e.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});
});

test("SSE lines split across chunks", () => {
	const s = new SseLines();
	expect(s.push('data: {"a"')).toEqual([]);
	expect(s.push(":1}\n\ndata: [DONE]\n")).toEqual(['{"a":1}', "[DONE]"]);
});

describe("upstream failures", () => {
	test("quota errors hide behind other statuses", () => {
		expect(classifyFailure(429, "")).toBe("quota");
		expect(classifyFailure(400, "Rate limit reached for requests")).toBe(
			"quota",
		);
		expect(classifyFailure(403, "FreeTierError: use the official client")).toBe(
			"quota",
		);
		expect(classifyFailure(403, "invalid api key")).toBe("auth");
		expect(classifyFailure(400, "messages: field required")).toBe("request");
		expect(classifyFailure(404, "model not found")).toBe("missing");
		expect(classifyFailure(503, "")).toBe("transient");
	});

	test("back-off doubles and caps", () => {
		expect([1, 2, 3, 9, 20].map(backoffSeconds)).toEqual([2, 4, 8, 300, 300]);
	});

	test("daily allowance converts hours and months, skips minutes", () => {
		expect(
			dailyAllowance([
				{ amount: 100, unit: "requests", per: "hour" },
				{ amount: 1_000_000, unit: "tokens", per: "day" },
				{ amount: 3_000_000, unit: "tokens", per: "month" },
				{ amount: 20, unit: "requests", per: "minute" },
			]),
		).toEqual({ tokens: 1_100_000, requests: 2_400 });
	});
});
