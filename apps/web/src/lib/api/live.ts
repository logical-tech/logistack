import type { LiveMessage } from "@logistack/contracts";

/** Log stream frames, mirroring `StreamMessage` in `apps/server/src/streams.ts`. */
export type StreamFrame =
	| {
			type: "line";
			channel: string;
			line: string;
			seq?: number;
			at?: string;
			taskId?: string;
			slot?: number | null;
			stream?: "stdout" | "stderr";
	  }
	| { type: "end"; channel: string; reason: string };

type Frame = { type?: string; channel?: string; data?: LiveMessage };
type Listener = (msg: Frame) => void;

const listeners = new Map<string, Set<Listener>>();
/** Subscribe options per channel, resent on every (re)subscribe. */
const options = new Map<string, unknown>();
let socket: WebSocket | undefined;
let retry = 0;

function send(msg: { type: "subscribe" | "unsubscribe"; channel: string }) {
	if (socket?.readyState !== WebSocket.OPEN) return;
	const opts = msg.type === "subscribe" ? options.get(msg.channel) : undefined;
	socket.send(JSON.stringify(opts ? { ...msg, options: opts } : msg));
}

function open() {
	if (socket || listeners.size === 0) return;
	const url = new URL("/ws", window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(url);
	socket = ws;
	ws.onopen = () => {
		retry = 0;
		for (const channel of listeners.keys())
			send({ type: "subscribe", channel });
	};
	ws.onmessage = (e) => {
		let msg: Frame;
		try {
			msg = JSON.parse(String(e.data));
		} catch {
			return;
		}
		if (!msg.channel) return;
		for (const fn of listeners.get(msg.channel) ?? []) fn(msg);
	};
	ws.onclose = () => {
		// A socket closed on purpose has already been replaced or dropped.
		if (socket !== ws) return;
		socket = undefined;
		if (listeners.size === 0) return;
		// Polling keeps the views fresh meanwhile; reconnect with a capped backoff.
		retry = Math.min(retry + 1, 6);
		setTimeout(open, 500 * 2 ** retry);
	};
}

function listen(channel: string, fn: Listener, opts?: unknown): () => void {
	let set = listeners.get(channel);
	if (opts !== undefined) options.set(channel, opts);
	if (!set) {
		set = new Set();
		listeners.set(channel, set);
		send({ type: "subscribe", channel });
	}
	set.add(fn);
	open();
	return () => {
		set.delete(fn);
		if (set.size) return;
		listeners.delete(channel);
		options.delete(channel);
		send({ type: "unsubscribe", channel });
		if (listeners.size === 0) {
			socket?.close();
			socket = undefined;
		}
	};
}

/** Live `data` frames for one /ws channel. Returns the unsubscribe. */
export const subscribe = (channel: string, fn: (data: LiveMessage) => void) =>
	listen(channel, (m) => {
		if (m.type === "data" && m.data) fn(m.data);
	});

/**
 * Log `line` and `end` frames for a `deployment-log:` or `service-logs:` channel. The server
 * replays, then follows; a reconnect subscribes again and replays again.
 */
export const subscribeStream = (
	channel: string,
	opts: unknown,
	fn: (frame: StreamFrame) => void,
) =>
	listen(
		channel,
		(m) => {
			if (m.type === "line" || m.type === "end") fn(m as StreamFrame);
		},
		opts,
	);
