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

/** The OpenAI Responses request fields the gateway translates for non-OpenAI upstreams. */
export type ResponsesRequest = {
	model: string;
	input: string | ResponsesItem[];
	instructions?: string;
	tools?: {
		type: string;
		name?: string;
		description?: string;
		parameters?: unknown;
	}[];
	tool_choice?: "auto" | "none" | "required" | { type: string; name?: string };
	max_output_tokens?: number;
	temperature?: number;
	top_p?: number;
	stream?: boolean;
};

type ResponsesPart = {
	type: string;
	text?: string;
	image_url?: string | { url: string };
};

type ResponsesItem =
	| {
			type?: "message";
			role: "user" | "assistant" | "system" | "developer";
			content: string | ResponsesPart[];
	  }
	| { type: "function_call"; call_id: string; name: string; arguments: string }
	| { type: "function_call_output"; call_id: string; output: string }
	| { type: string; [k: string]: unknown };

function partsOf(content: string | ResponsesPart[]): ChatContentPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.flatMap((p): ChatContentPart[] => {
		if (p.text !== undefined) return [{ type: "text", text: p.text }];
		if (p.type === "input_image" && p.image_url)
			return [
				{
					type: "image_url",
					image_url: {
						url:
							typeof p.image_url === "string" ? p.image_url : p.image_url.url,
					},
				},
			];
		return [];
	});
}

const joined = (parts: ChatContentPart[]) =>
	parts.map((p) => (p.type === "text" ? p.text : "")).join("");

function toolChoice(
	c: ResponsesRequest["tool_choice"],
): ChatToolChoice | undefined {
	if (c === undefined || typeof c === "string") return c;
	return c.name ? { type: "function", function: { name: c.name } } : "auto";
}

export function responsesToChat(req: ResponsesRequest): ChatRequest {
	const messages: ChatMessage[] = [];
	if (req.instructions)
		messages.push({ role: "system", content: req.instructions });
	const items: ResponsesItem[] =
		typeof req.input === "string"
			? [{ role: "user", content: req.input }]
			: req.input;
	for (const item of items) {
		if (item.type === "function_call") {
			const call = item as Extract<ResponsesItem, { type: "function_call" }>;
			const tool = {
				id: call.call_id,
				type: "function" as const,
				function: { name: call.name, arguments: call.arguments },
			};
			// Consecutive calls belong to one assistant turn.
			const last = messages.at(-1);
			if (last?.role === "assistant" && last.tool_calls)
				last.tool_calls.push(tool);
			else
				messages.push({ role: "assistant", content: null, tool_calls: [tool] });
		} else if (item.type === "function_call_output") {
			const out = item as Extract<
				ResponsesItem,
				{ type: "function_call_output" }
			>;
			messages.push({
				role: "tool",
				tool_call_id: out.call_id,
				content:
					typeof out.output === "string"
						? out.output
						: JSON.stringify(out.output),
			});
		} else if ("role" in item) {
			const m = item as Extract<ResponsesItem, { role: string }>;
			const parts = partsOf(m.content);
			if (m.role === "user")
				messages.push({
					role: "user",
					content: parts.every((p) => p.type === "text")
						? joined(parts)
						: parts,
				});
			else if (m.role === "assistant")
				messages.push({ role: "assistant", content: joined(parts) });
			else messages.push({ role: "system", content: joined(parts) });
		}
	}
	const tools = req.tools
		?.filter((t) => t.type === "function" && t.name)
		.map((t) => ({
			type: "function" as const,
			function: {
				name: t.name as string,
				description: t.description,
				parameters: t.parameters,
			},
		}));
	return {
		model: req.model,
		messages,
		tools: tools?.length ? tools : undefined,
		tool_choice: tools?.length ? toolChoice(req.tool_choice) : undefined,
		max_tokens: req.max_output_tokens,
		temperature: req.temperature,
		top_p: req.top_p,
		stream: req.stream,
	};
}

function usageBlock(u: { input: number; output: number; cached: number }) {
	return {
		input_tokens: u.input,
		input_tokens_details: { cached_tokens: u.cached },
		output_tokens: u.output,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: u.input + u.output,
	};
}

const incomplete = (finish: string | null | undefined) =>
	finish === "length" ? { reason: "max_output_tokens" } : null;

export function chatToResponses(res: ChatResponse, model: string) {
	const choice = res.choices[0];
	const output: unknown[] = [];
	if (choice?.message.content)
		output.push({
			type: "message",
			id: `msg_${crypto.randomUUID()}`,
			status: "completed",
			role: "assistant",
			content: [
				{ type: "output_text", text: choice.message.content, annotations: [] },
			],
		});
	for (const call of choice?.message.tool_calls ?? [])
		output.push({
			type: "function_call",
			id: `fc_${crypto.randomUUID()}`,
			call_id: call.id,
			name: call.function.name,
			arguments: call.function.arguments,
			status: "completed",
		});
	const details = incomplete(choice?.finish_reason);
	return {
		id: `resp_${res.id ?? crypto.randomUUID()}`,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status: details ? "incomplete" : "completed",
		incomplete_details: details,
		model,
		output,
		usage: usageBlock(usageOf(res.usage)),
	};
}

type OpenItem =
	| { kind: "text"; id: string; text: string }
	| {
			kind: "call";
			id: string;
			callId: string;
			name: string;
			args: string;
			chatIndex: number;
	  };

/** Re-encodes a chat stream as Responses API events. `push` per chunk, `finish` once at the end. */
export class ResponsesStreamEncoder {
	#seq = 0;
	#id = `resp_${crypto.randomUUID()}`;
	#created = Math.floor(Date.now() / 1000);
	#started = false;
	#open: OpenItem | undefined;
	#done: unknown[] = [];
	#finish: string | null | undefined;
	#usage = { input: 0, output: 0, cached: 0 };
	constructor(private readonly model: string) {}

	#emit(type: string, data: Record<string, unknown>) {
		return sse(type, { type, sequence_number: this.#seq++, ...data });
	}

	#response(status: string, output: unknown[]) {
		return {
			id: this.#id,
			object: "response",
			created_at: this.#created,
			status,
			model: this.model,
			output,
		};
	}

	#start(): string[] {
		if (this.#started) return [];
		this.#started = true;
		return [
			this.#emit("response.created", {
				response: this.#response("in_progress", []),
			}),
		];
	}

	#item(o: OpenItem) {
		return o.kind === "text"
			? {
					type: "message",
					id: o.id,
					status: "completed",
					role: "assistant",
					content: [{ type: "output_text", text: o.text, annotations: [] }],
				}
			: {
					type: "function_call",
					id: o.id,
					call_id: o.callId,
					name: o.name,
					arguments: o.args,
					status: "completed",
				};
	}

	#close(): string[] {
		const o = this.#open;
		if (!o) return [];
		this.#open = undefined;
		const index = this.#done.length;
		const item = this.#item(o);
		this.#done.push(item);
		const out: string[] = [];
		if (o.kind === "text")
			out.push(
				this.#emit("response.output_text.done", {
					item_id: o.id,
					output_index: index,
					content_index: 0,
					text: o.text,
				}),
			);
		else
			out.push(
				this.#emit("response.function_call_arguments.done", {
					item_id: o.id,
					output_index: index,
					arguments: o.args,
				}),
			);
		out.push(
			this.#emit("response.output_item.done", { output_index: index, item }),
		);
		return out;
	}

	push(chunk: ChatChunk): string[] {
		const out = this.#start();
		if (chunk.usage) this.#usage = usageOf(chunk.usage);
		const choice = chunk.choices?.[0];
		if (choice?.finish_reason) this.#finish = choice.finish_reason;
		const delta = choice?.delta;
		if (delta?.content) {
			if (this.#open?.kind !== "text") {
				out.push(...this.#close());
				const id = `msg_${crypto.randomUUID()}`;
				this.#open = { kind: "text", id, text: "" };
				out.push(
					this.#emit("response.output_item.added", {
						output_index: this.#done.length,
						item: {
							type: "message",
							id,
							status: "in_progress",
							role: "assistant",
							content: [],
						},
					}),
					this.#emit("response.content_part.added", {
						item_id: id,
						output_index: this.#done.length,
						content_index: 0,
						part: { type: "output_text", text: "", annotations: [] },
					}),
				);
			}
			const open = this.#open as Extract<OpenItem, { kind: "text" }>;
			open.text += delta.content;
			out.push(
				this.#emit("response.output_text.delta", {
					item_id: open.id,
					output_index: this.#done.length,
					content_index: 0,
					delta: delta.content,
				}),
			);
		}
		for (const call of delta?.tool_calls ?? []) {
			const open = this.#open;
			if (open?.kind !== "call" || open.chatIndex !== call.index) {
				out.push(...this.#close());
				const next: OpenItem = {
					kind: "call",
					id: `fc_${crypto.randomUUID()}`,
					callId: call.id ?? `call_${crypto.randomUUID()}`,
					name: call.function?.name ?? "",
					args: "",
					chatIndex: call.index,
				};
				this.#open = next;
				out.push(
					this.#emit("response.output_item.added", {
						output_index: this.#done.length,
						item: {
							type: "function_call",
							id: next.id,
							call_id: next.callId,
							name: next.name,
							arguments: "",
							status: "in_progress",
						},
					}),
				);
			}
			const current = this.#open as Extract<OpenItem, { kind: "call" }>;
			const args = call.function?.arguments ?? "";
			if (args) {
				current.args += args;
				out.push(
					this.#emit("response.function_call_arguments.delta", {
						item_id: current.id,
						output_index: this.#done.length,
						delta: args,
					}),
				);
			}
		}
		return out;
	}

	finish(): string[] {
		const out = [...this.#start(), ...this.#close()];
		const details = incomplete(this.#finish);
		out.push(
			this.#emit(details ? "response.incomplete" : "response.completed", {
				response: {
					...this.#response(details ? "incomplete" : "completed", this.#done),
					incomplete_details: details,
					usage: usageBlock(this.#usage),
				},
			}),
		);
		return out;
	}
}

/** Token counts from a native Responses `usage` block. */
export function responsesUsage(u: {
	input_tokens?: number;
	output_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}) {
	return {
		input: u.input_tokens ?? 0,
		output: u.output_tokens ?? 0,
		cached: u.input_tokens_details?.cached_tokens ?? 0,
	};
}
