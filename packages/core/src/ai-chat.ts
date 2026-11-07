/**
 * The OpenAI chat-completions shapes the gateway speaks internally. Upstreams are called with
 * these; the Anthropic and Responses front doors translate to and from them.
 */

export type ChatContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

export type ChatToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

export type ChatMessage =
	| { role: "system" | "developer"; content: string }
	| { role: "user"; content: string | ChatContentPart[] }
	| {
			role: "assistant";
			content: string | null;
			tool_calls?: ChatToolCall[];
	  }
	| { role: "tool"; tool_call_id: string; content: string };

export type ChatTool = {
	type: "function";
	function: { name: string; description?: string; parameters?: unknown };
};

export type ChatToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; function: { name: string } };

export type ChatRequest = {
	model: string;
	messages: ChatMessage[];
	tools?: ChatTool[];
	tool_choice?: ChatToolChoice;
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string[];
	stream?: boolean;
	stream_options?: { include_usage?: boolean };
	[extra: string]: unknown;
};

export type ChatUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number };
};

export type ChatResponse = {
	id?: string;
	model?: string;
	choices: {
		message: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: ChatToolCall[];
		};
		finish_reason?: string | null;
	}[];
	usage?: ChatUsage;
};

export type ChatChunk = {
	id?: string;
	model?: string;
	choices?: {
		delta?: {
			content?: string | null;
			tool_calls?: {
				index: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}[];
		};
		finish_reason?: string | null;
	}[];
	usage?: ChatUsage | null;
};

export function usageOf(u: ChatUsage | null | undefined) {
	return {
		input: u?.prompt_tokens ?? 0,
		output: u?.completion_tokens ?? 0,
		cached: u?.prompt_tokens_details?.cached_tokens ?? 0,
	};
}

/** Splits an SSE byte stream into `data:` payloads, one per event. Feed text, get payloads back. */
export class SseLines {
	#buf = "";
	push(text: string): string[] {
		this.#buf += text;
		const out: string[] = [];
		let nl = this.#buf.indexOf("\n");
		while (nl >= 0) {
			const line = this.#buf.slice(0, nl).replace(/\r$/, "");
			this.#buf = this.#buf.slice(nl + 1);
			if (line.startsWith("data:")) out.push(line.slice(5).trim());
			nl = this.#buf.indexOf("\n");
		}
		return out;
	}
}

/** A chat stream's chunks, parsed; `[DONE]` and malformed lines are dropped. */
export function parseChunk(data: string): ChatChunk | undefined {
	if (data === "[DONE]" || data === "") return undefined;
	try {
		return JSON.parse(data) as ChatChunk;
	} catch {
		return undefined;
	}
}

export const sse = (event: string, data: unknown) =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
