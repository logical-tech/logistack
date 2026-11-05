import { toDockerError } from "./errors.ts";
import { Demuxer, type Frame } from "./stream.ts";
import type { Filters } from "./types.ts";

export type QueryValue = string | number | boolean | Filters | undefined;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
	query?: Query;
	body?: unknown;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface Transport {
	/** JSON request; resolves to the parsed body, or undefined for an empty body. */
	json<T>(method: string, path: string, opts?: RequestOptions): Promise<T>;
	/** Streaming request; resolves once headers arrive with a non-error status. */
	stream(
		method: string,
		path: string,
		opts?: RequestOptions,
	): Promise<Response>;
	hijack(
		path: string,
		body: unknown,
		signal?: AbortSignal,
	): Promise<HijackedStream>;
}

export interface HijackedStream {
	/** stdout/stderr frames; a TTY stream arrives as `stdout`. Ends when the remote closes. */
	output: ReadableStream<Frame>;
	/** Resolves once the bytes are handed to the kernel, so large inputs apply backpressure. */
	write(data: string | Uint8Array): Promise<void>;
	/** Half-close: sends EOF to the process stdin while output keeps flowing. */
	closeStdin(): Promise<void>;
	close(): void;
	closed: Promise<void>;
}

export function createTransport(
	socketPath: string,
	apiVersion: string,
): Transport {
	const prefix = `/v${apiVersion}`;

	function url(path: string, query?: Query): string {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(query ?? {})) {
			if (v === undefined) continue;
			params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
		}
		const qs = params.size ? `?${params}` : "";
		return `http://docker${prefix}${path}${qs}`;
	}

	async function send(
		method: string,
		path: string,
		opts: RequestOptions = {},
	): Promise<Response> {
		const headers: Record<string, string> = { ...opts.headers };
		let body: string | Uint8Array | undefined;
		// Bytes go as they are (a tar for the archive endpoint); anything else is JSON.
		if (opts.body instanceof Uint8Array) body = opts.body;
		else if (opts.body !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(opts.body);
		}
		const res = await fetch(url(path, opts.query), {
			method,
			headers,
			body,
			signal: opts.signal,
			unix: socketPath,
		});
		if (!res.ok)
			throw toDockerError(res.status, await res.text(), method, path);
		return res;
	}

	return {
		async json<T>(
			method: string,
			path: string,
			opts?: RequestOptions,
		): Promise<T> {
			const text = await (await send(method, path, opts)).text();
			return (text ? JSON.parse(text) : undefined) as T;
		},
		stream: send,
		hijack: (path, body, signal) =>
			hijack(socketPath, `${prefix}${path}`, body, signal),
	};
}

const HEADER_END = new Uint8Array([13, 10, 13, 10]);

// fetch cannot do this: its request body is not flushed until the body stream ends (see docs/spikes/docker.md).
async function hijack(
	socketPath: string,
	path: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<HijackedStream> {
	const payload = new TextEncoder().encode(JSON.stringify(body));
	const head = Promise.withResolvers<number>();
	const closed = Promise.withResolvers<void>();
	let out!: ReadableStreamDefaultController<Frame>;
	// shortcut: no read-side backpressure (socket is not paused when the consumer lags); fine for shells and dumps read promptly.
	const output = new ReadableStream<Frame>({
		start(c) {
			out = c;
		},
		cancel() {
			sock.end();
		},
	});
	let headBuf: Uint8Array | null = new Uint8Array(0);
	let demuxer: Demuxer | null = null;
	let errorBody = "";
	let errorBytesLeft = Number.POSITIVE_INFINITY;
	const pending: { data: Uint8Array; done: (err?: Error) => void }[] = [];
	let shutdownWhenFlushed = false;
	let isClosed = false;

	const deliver = (chunk: Uint8Array) => {
		if (errorBody || !headBuf) {
			if (errorBody) {
				errorBody += new TextDecoder().decode(chunk);
				errorBytesLeft -= chunk.length;
				// error responses are not hijacked; the engine may keep the connection open after the body
				if (errorBytesLeft <= 0) sock.end();
			} else if (demuxer) for (const f of demuxer.push(chunk)) out.enqueue(f);
			else out.enqueue({ stream: "stdout", data: chunk });
			return;
		}
		const buf = concat(headBuf, chunk);
		const end = indexOf(buf, HEADER_END);
		if (end < 0) {
			headBuf = buf;
			return;
		}
		headBuf = null;
		const lines = new TextDecoder().decode(buf.subarray(0, end)).split("\r\n");
		const status = Number(lines[0]?.split(" ")[1]);
		const contentType =
			lines.find((l) => l.toLowerCase().startsWith("content-type:")) ?? "";
		const rest = buf.subarray(end + 4);
		if (status !== 101 && status !== 200) {
			const length = lines.find((l) =>
				l.toLowerCase().startsWith("content-length:"),
			);
			if (length) errorBytesLeft = Number(length.split(":")[1]);
			errorBody = " ";
			head.resolve(status);
			deliver(rest);
			return;
		}
		if (contentType.includes("multiplexed")) demuxer = new Demuxer();
		head.resolve(status);
		if (rest.length) deliver(rest);
	};

	const flush = () => {
		while (pending.length && !isClosed) {
			const item = pending[0] as (typeof pending)[number];
			const n = sock.write(item.data);
			if (n < item.data.length) {
				item.data = item.data.subarray(Math.max(n, 0));
				return;
			}
			pending.shift();
			item.done();
		}
		if (shutdownWhenFlushed) sock.shutdown();
	};

	const sock = await Bun.connect({
		unix: socketPath,
		allowHalfOpen: true,
		socket: {
			data: (_s, chunk) => {
				try {
					deliver(chunk);
				} catch (e) {
					out.error(e);
					sock.end();
				}
			},
			drain: flush,
			end: (s) => {
				s.end();
			},
			close: () => {
				isClosed = true;
				for (const p of pending.splice(0))
					p.done(
						new Error(
							`hijacked connection closed before write completed on ${path}`,
						),
					);
				if (headBuf)
					head.reject(
						new Error(`connection closed before response headers on ${path}`),
					);
				try {
					if (demuxer?.pending)
						out.error(new Error("multiplexed stream ended mid-frame"));
					else out.close();
				} catch {
					// stream already closed or errored by the consumer
				}
				closed.resolve();
			},
			error: (_s, e) => {
				isClosed = true;
				for (const p of pending.splice(0)) p.done(e);
				head.reject(e);
				out.error(e);
				closed.resolve();
			},
		},
	});
	// An abort before this point would never fire the listener.
	if (signal?.aborted) sock.end();
	else signal?.addEventListener("abort", () => sock.end(), { once: true });

	pending.push({
		data: concat(
			new TextEncoder().encode(
				`POST ${path} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${payload.length}\r\n\r\n`,
			),
			payload,
		),
		done: () => {},
	});
	flush();

	const status = await head.promise;
	if (errorBody) {
		await closed.promise;
		throw toDockerError(status, errorBody.trim(), "POST", path);
	}

	const enqueue = (data: Uint8Array) => {
		if (isClosed)
			return Promise.reject(
				new Error(`hijacked connection already closed on ${path}`),
			);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		pending.push({ data, done: (err) => (err ? reject(err) : resolve()) });
		if (pending.length === 1) flush();
		return promise;
	};

	return {
		output,
		write: (data) =>
			enqueue(typeof data === "string" ? new TextEncoder().encode(data) : data),
		closeStdin() {
			shutdownWhenFlushed = true;
			return enqueue(new Uint8Array(0));
		},
		close: () => sock.end(),
		closed: closed.promise,
	};
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (!a.length) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
	outer: for (let i = 0; i <= hay.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++)
			if (hay[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}
