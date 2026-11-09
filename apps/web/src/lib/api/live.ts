import type {
	EventEnvelope,
	LiveMessage,
	WorkRealtimeMessage,
} from "@logistack/contracts";

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
/** Bare Work messages, pushed unasked by the server to every socket that may read them. */
const workListeners = new Set<(msg: WorkRealtimeMessage) => void>();
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
	if (socket || (listeners.size === 0 && workListeners.size === 0)) return;
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
		if (msg.type === "work") {
			for (const fn of workListeners) fn(msg as unknown as WorkRealtimeMessage);
			return;
		}
		if (!msg.channel) return;
		for (const fn of listeners.get(msg.channel) ?? []) fn(msg);
	};
	ws.onclose = () => {
		// A socket closed on purpose has already been replaced or dropped.
		if (socket !== ws) return;
		socket = undefined;
		if (listeners.size === 0 && workListeners.size === 0) return;
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
		closeIfIdle();
	};
}

function closeIfIdle() {
	if (listeners.size || workListeners.size) return;
	socket?.close();
	socket = undefined;
}

/** Persisted `event` frames for one /ws channel (`migration:<id>`...). Returns the unsubscribe. */
export const subscribeEvents = (
	channel: string,
	fn: (event: EventEnvelope) => void,
) =>
	listen(channel, (m) => {
		const e = (m as { event?: EventEnvelope }).event;
		if (m.type === "event" && e) fn(e);
	});

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

/**
 * Every Work message this actor may read (section 9). The server pushes them as bare
 * `{ type: "work", ... }` frames with no subscription; filter by `projectId` or `userId` yourself.
 */
export function subscribeAllWork(
	fn: (msg: WorkRealtimeMessage) => void,
): () => void {
	workListeners.add(fn);
	open();
	return () => {
		workListeners.delete(fn);
		closeIfIdle();
	};
}

/** Work messages for one project. Returns the unsubscribe. */
export const subscribeWork = (
	projectId: string,
	fn: (msg: WorkRealtimeMessage) => void,
) =>
	subscribeAllWork((msg) => {
		if (msg.projectId === projectId) fn(msg);
	});
