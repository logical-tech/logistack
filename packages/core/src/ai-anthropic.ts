import {
	type ChatChunk,
	type ChatContentPart,
	type ChatMessage,
	type ChatRequest,
	type ChatResponse,
	type ChatToolChoice,
	sse,
	usageOf,
} from "./ai-chat.ts";

/** The Anthropic Messages request fields the gateway translates; others are dropped. */
export type AnthropicRequest = {
	model: string;
	max_tokens?: number;
	system?: string | { type: "text"; text: string }[];
	messages: {
		role: "user" | "assistant";
		content: string | AnthropicBlock[];
	}[];
	tools?: { name: string; description?: string; input_schema?: unknown }[];
	tool_choice?: { type: "auto" | "any" | "none" | "tool"; name?: string };
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	stream?: boolean;
};

type AnthropicBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			source:
				| { type: "base64"; media_type: string; data: string }
				| { type: "url"; url: string };
	  }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| {
			type: "tool_result";
			tool_use_id: string;
			content?: string | { type: string; text?: string }[];
	  }
	| { type: string; [k: string]: unknown };

const text = (blocks: { type: string; text?: string }[]) =>
	blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("");

function toolChoice(
	c: AnthropicRequest["tool_choice"],
): ChatToolChoice | undefined {
	switch (c?.type) {
		case "any":
			return "required";
		case "none":
			return "none";
		case "tool":
			return { type: "function", function: { name: c.name ?? "" } };
		case "auto":
			return "auto";
		default:
			return undefined;
	}
}

export function anthropicToChat(req: AnthropicRequest): ChatRequest {
	const messages: ChatMessage[] = [];
	const system =
		typeof req.system === "string" ? req.system : text(req.system ?? []);
	if (system) messages.push({ role: "system", content: system });
	for (const m of req.messages) {
		if (typeof m.content === "string") {
			messages.push(
				m.role === "user"
					? { role: "user", content: m.content }
					: { role: "assistant", content: m.content },
			);
			continue;
		}
		if (m.role === "assistant") {
			const calls = m.content.flatMap((b) =>
				b.type === "tool_use"
					? [
							{
								id: String(b.id),
								type: "function" as const,
								function: {
									name: String(b.name),
									arguments: JSON.stringify(b.input ?? {}),
								},
							},
						]
					: [],
			);
			messages.push({
				role: "assistant",
				content: text(m.content as { type: string; text?: string }[]) || null,
				...(calls.length ? { tool_calls: calls } : {}),
			});
			continue;
		}
		// A user turn: tool results become `tool` messages, the rest one user message.
		const parts: ChatContentPart[] = [];
		for (const b of m.content) {
			if (b.type === "tool_result") {
				const r = b as Extract<AnthropicBlock, { type: "tool_result" }>;
				messages.push({
					role: "tool",
					tool_call_id: r.tool_use_id,
					content:
						typeof r.content === "string" ? r.content : text(r.content ?? []),
				});
			} else if (b.type === "text") {
				parts.push({ type: "text", text: String(b.text) });
			} else if (b.type === "image") {
				const s = (b as Extract<AnthropicBlock, { type: "image" }>).source;
				const url =
					s.type === "base64" ? `data:${s.media_type};base64,${s.data}` : s.url;
				parts.push({ type: "image_url", image_url: { url } });
			}
		}
		if (parts.length)
			messages.push({
				role: "user",
				content:
					parts.length === 1 && parts[0]?.type === "text"
						? parts[0].text
						: parts,
			});
	}
	return {
		model: req.model,
		messages,
		max_tokens: req.max_tokens,
		temperature: req.temperature,
		top_p: req.top_p,
		stop: req.stop_sequences,
		stream: req.stream,
		tools: req.tools?.map((t) => ({
			type: "function",
			function: {
				name: t.name,
				description: t.description,
				parameters: t.input_schema,
			},
		})),
		tool_choice: toolChoice(req.tool_choice),
	};
}

const STOP: Record<string, string> = {
	stop: "end_turn",
	length: "max_tokens",
	tool_calls: "tool_use",
	content_filter: "refusal",
};

const stopReason = (finish: string | null | undefined) =>
	STOP[finish ?? "stop"] ?? "end_turn";

function parseArgs(raw: string): unknown {
	try {
		return JSON.parse(raw || "{}");
	} catch {
		return {};
	}
}

export function chatToAnthropic(res: ChatResponse, model: string) {
	const choice = res.choices[0];
	const content: unknown[] = [];
	if (choice?.message.content)
		content.push({ type: "text", text: choice.message.content });
	for (const call of choice?.message.tool_calls ?? [])
		content.push({
			type: "tool_use",
			id: call.id,
			name: call.function.name,
			input: parseArgs(call.function.arguments),
		});
	const u = usageOf(res.usage);
	return {
		id: `msg_${res.id ?? crypto.randomUUID()}`,
		type: "message",
		role: "assistant",
		model,
		content,
		stop_reason: stopReason(choice?.finish_reason),
		stop_sequence: null,
		usage: {
			input_tokens: u.input - u.cached,
			output_tokens: u.output,
			cache_read_input_tokens: u.cached,
		},
	};
}

/** Re-encodes a chat stream as Anthropic Messages events. `push` per chunk, `finish` once at the end. */
export class AnthropicStreamEncoder {
	#started = false;
	#index = -1;
	/** The open block: text, or the chat tool-call index it mirrors. */
	#open: { kind: "text" } | { kind: "tool"; call: number } | undefined;
	#finish: string | null | undefined;
	#usage = { input: 0, output: 0, cached: 0 };
	constructor(private readonly model: string) {}

	#start(id?: string): string[] {
		if (this.#started) return [];
		this.#started = true;
		return [
			sse("message_start", {
				type: "message_start",
				message: {
					id: `msg_${id ?? crypto.randomUUID()}`,
					type: "message",
					role: "assistant",
					model: this.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			}),
		];
	}

	#close(): string[] {
		if (!this.#open) return [];
		this.#open = undefined;
		return [
			sse("content_block_stop", {
				type: "content_block_stop",
				index: this.#index,
			}),
		];
	}

	push(chunk: ChatChunk): string[] {
		const out = this.#start(chunk.id);
		if (chunk.usage) this.#usage = usageOf(chunk.usage);
		const choice = chunk.choices?.[0];
		if (choice?.finish_reason) this.#finish = choice.finish_reason;
		const delta = choice?.delta;
		if (delta?.content) {
			if (this.#open?.kind !== "text") {
				out.push(...this.#close());
				this.#index++;
				this.#open = { kind: "text" };
				out.push(
					sse("content_block_start", {
						type: "content_block_start",
						index: this.#index,
						content_block: { type: "text", text: "" },
					}),
				);
			}
			out.push(
				sse("content_block_delta", {
					type: "content_block_delta",
					index: this.#index,
					delta: { type: "text_delta", text: delta.content },
				}),
			);
		}
		for (const call of delta?.tool_calls ?? []) {
			const open = this.#open;
			if (open?.kind !== "tool" || open.call !== call.index) {
				out.push(...this.#close());
				this.#index++;
				this.#open = { kind: "tool", call: call.index };
				out.push(
					sse("content_block_start", {
						type: "content_block_start",
						index: this.#index,
						content_block: {
							type: "tool_use",
							id: call.id ?? `toolu_${crypto.randomUUID()}`,
							name: call.function?.name ?? "",
							input: {},
						},
					}),
				);
			}
			if (call.function?.arguments)
				out.push(
					sse("content_block_delta", {
						type: "content_block_delta",
						index: this.#index,
						delta: {
							type: "input_json_delta",
							partial_json: call.function.arguments,
						},
					}),
				);
		}
		return out;
	}

	finish(): string[] {
		return [
			...this.#start(),
			...this.#close(),
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: stopReason(this.#finish), stop_sequence: null },
				usage: {
					input_tokens: this.#usage.input - this.#usage.cached,
					output_tokens: this.#usage.output,
					cache_read_input_tokens: this.#usage.cached,
				},
			}),
			sse("message_stop", { type: "message_stop" }),
		];
	}
}

/** Token counts from a native Anthropic response or its `message_start` / `message_delta` events. */
export function anthropicUsage(u: {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}) {
	const cached = u.cache_read_input_tokens ?? 0;
	return {
		input:
			(u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0),
		output: u.output_tokens ?? 0,
		cached,
	};
}
