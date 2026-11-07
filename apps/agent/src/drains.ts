import { createSocket } from "node:dgram";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type {
	DrainNodeStatus,
	DrainsConfig,
	LogDrainConfig,
	LogMeta,
	LogRecord,
} from "@logistack/contracts";
import { type EncodedBatch, encodeDrainBatch } from "@logistack/core/drains";
import {
	type DockerClient,
	LABEL_MANAGED,
	LABEL_RESOURCE,
} from "@logistack/docker";
import { lineSplitter } from "./sessions.ts";

// Ships container logs to the drains in the server's `drains.config`. Per drain: one bounded
// queue and one sender loop. Memory per drain never exceeds `maxQueueBytes` (queued plus in
// flight). A slow but working drain pauses the Docker log stream (backpressure; dockerd keeps
// the lines in its log file); a failing one sheds the oldest lines instead of holding them.

export type DrainLimits = {
	maxQueueBytes: number;
	maxBatchLines: number;
	maxBatchBytes: number;
	flushMs: number;
	timeoutMs: number;
	maxBackoffMs: number;
};

export const DEFAULT_LIMITS: DrainLimits = {
	maxQueueBytes: 8 * 1024 * 1024,
	maxBatchLines: 1000,
	maxBatchBytes: 1024 * 1024,
	flushMs: 1000,
	timeoutMs: 10_000,
	maxBackoffMs: 60_000,
};

/** Delivers one encoded batch; throws on any failure. */
export type Transport = (
	batch: EncodedBatch,
	signal: AbortSignal,
) => Promise<{ status?: number }>;

export class DrainHttpError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}

export const sendBatch: Transport = async (batch, signal) => {
	if (batch.kind === "http") {
		const res = await fetch(batch.url, {
			method: "POST",
			headers: batch.headers,
			body: batch.body,
			signal,
			redirect: "error",
		});
		// The body is never read: its content stays at the destination.
		await res.body?.cancel().catch(() => {});
		if (!res.ok) throw new DrainHttpError(res.status);
		return { status: res.status };
	}
	const payload = batch.messages;
	if (batch.protocol === "udp") {
		// shortcut: IPv4 only; switch to a family lookup if someone drains to an IPv6-only syslog.
		const sock = createSocket("udp4");
		try {
			for (const m of payload)
				await new Promise<void>((resolve, reject) =>
					sock.send(m, batch.port, batch.host, (e) =>
						e ? reject(e) : resolve(),
					),
				);
		} finally {
			sock.close();
		}
		return {};
	}
	await new Promise<void>((resolve, reject) => {
		const opts = { host: batch.host, port: batch.port };
		const sock =
			batch.protocol === "tls"
				? tlsConnect({ ...opts, servername: batch.host })
				: tcpConnect(opts);
		const fail = (e: unknown) => {
			sock.destroy();
			reject(e instanceof Error ? e : new Error(String(e)));
		};
		signal.addEventListener("abort", () => fail(signal.reason), { once: true });
		sock.once("error", fail);
		sock.once(batch.protocol === "tls" ? "secureConnect" : "connect", () =>
			sock.end(payload.join(""), () => resolve()),
		);
	});
	return {};
};

/** Rough bytes a queued record holds; `meta` is shared, so only the line counts. */
const sizeOf = (r: LogRecord) => r.line.length + 64;

/** One drain's queue and sender. */
export class DrainShipper {
	private queue: LogRecord[] = [];
	private head = 0;
	private bytes = 0;
	private inflightBytes = 0;
	private failures = 0;
	private wake: (() => void) | undefined;
	private closed = false;
	readonly status: DrainNodeStatus;

	constructor(
		readonly id: string,
		public config: LogDrainConfig,
		private transport: Transport,
		private limits: DrainLimits,
	) {
		this.status = {
			drainId: id,
			state: "idle",
			lastSuccessAt: null,
			lastFailureAt: null,
			lastError: null,
			sentLines: 0,
			droppedLines: 0,
			queuedLines: 0,
			queuedBytes: 0,
		};
		void this.loop();
	}

	get length() {
		return this.queue.length - this.head;
	}

	/** Bytes held: queued plus the batch in flight. */
	get heldBytes() {
		return this.bytes + this.inflightBytes;
	}

	/** Working but behind: the reader should wait instead of making it shed lines. */
	get congested() {
		return (
			this.status.state !== "failing" &&
			this.heldBytes > this.limits.maxQueueBytes * 0.75
		);
	}

	private shift(): LogRecord | undefined {
		if (this.head >= this.queue.length) return undefined;
		const r = this.queue[this.head++] as LogRecord;
		this.bytes -= sizeOf(r);
		if (this.head > 1024 && this.head * 2 > this.queue.length) {
			this.queue = this.queue.slice(this.head);
			this.head = 0;
		}
		return r;
	}

	push(r: LogRecord) {
		const size = sizeOf(r);
		if (size > this.limits.maxQueueBytes)
			return void this.status.droppedLines++;
		while (
			this.heldBytes + size > this.limits.maxQueueBytes &&
			this.length > 0
		) {
			this.shift();
			this.status.droppedLines++;
		}
		if (this.heldBytes + size > this.limits.maxQueueBytes)
			return void this.status.droppedLines++;
		this.queue.push(r);
		this.bytes += size;
		if (this.length >= this.limits.maxBatchLines) this.wake?.();
	}

	/** Puts a failed batch back in front, keeping only what fits. */
	private unshift(batch: LogRecord[]) {
		const rest = this.queue.slice(this.head);
		let room = this.limits.maxQueueBytes - this.bytes;
		const kept: LogRecord[] = [];
		for (let i = batch.length - 1; i >= 0; i--) {
			const r = batch[i] as LogRecord;
			if (sizeOf(r) > room) {
				this.status.droppedLines += i + 1;
				break;
			}
			room -= sizeOf(r);
			kept.unshift(r);
		}
		this.queue = [...kept, ...rest];
		this.head = 0;
		for (const r of kept) this.bytes += sizeOf(r);
	}

	private sleep(ms: number) {
		return new Promise<void>((resolve) => {
			const t = setTimeout(resolve, ms);
			this.wake = () => {
				clearTimeout(t);
				resolve();
			};
		}).finally(() => {
			this.wake = undefined;
		});
	}

	private take(): LogRecord[] {
		const batch: LogRecord[] = [];
		let bytes = 0;
		while (batch.length < this.limits.maxBatchLines && this.length > 0) {
			const next = this.queue[this.head] as LogRecord;
			if (batch.length > 0 && bytes + sizeOf(next) > this.limits.maxBatchBytes)
				break;
			bytes += sizeOf(next);
			batch.push(this.shift() as LogRecord);
		}
		this.inflightBytes = bytes;
		return batch;
	}

	private async loop() {
		while (!this.closed) {
			const backoff =
				this.failures === 0
					? this.limits.flushMs
					: Math.min(
							this.limits.maxBackoffMs,
							this.limits.flushMs * 2 ** this.failures,
						) *
						(0.5 + Math.random() / 2);
			// A full batch goes at once, unless the drain is backing off.
			if (this.failures > 0 || this.length < this.limits.maxBatchLines)
				await this.sleep(backoff);
			if (this.closed || this.length === 0) continue;
			const batch = this.take();
			try {
				await this.transport(
					encodeDrainBatch(this.config, batch),
					AbortSignal.timeout(this.limits.timeoutMs),
				);
				this.failures = 0;
				this.status.state = "ok";
				this.status.lastSuccessAt = Date.now();
				this.status.sentLines += batch.length;
			} catch (e) {
				this.failures++;
				this.status.state = "failing";
				this.status.lastFailureAt = Date.now();
				this.status.lastError = errText(e);
				this.inflightBytes = 0;
				if (!this.closed) this.unshift(batch);
			} finally {
				this.inflightBytes = 0;
			}
		}
	}

	snapshot(): DrainNodeStatus {
		return {
			...this.status,
			queuedLines: this.length,
			queuedBytes: this.heldBytes,
		};
	}

	close() {
		this.closed = true;
		this.queue = [];
		this.head = this.bytes = 0;
		this.wake?.();
	}
}

const errText = (e: unknown) =>
	(e instanceof Error
		? e.name === "TimeoutError"
			? "timed out"
			: e.message
		: String(e)
	).slice(0, 1024);

const TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/;

/** Splits Docker's `timestamps=true` prefix: `2026-11-07T10:00:00.123456789Z line`. */
export function parseTimestamped(
	raw: string,
): { at: number; nanos: number; line: string } | undefined {
	const sp = raw.indexOf(" ");
	const m = TS.exec(sp === -1 ? raw : raw.slice(0, sp));
	if (!m) return undefined;
	const frac = (m[2] ?? "").padEnd(9, "0");
	return {
		at: Date.parse(`${m[1]}Z`) + Number(frac.slice(0, 3)),
		nanos: Number(frac.slice(3)),
		line: sp === -1 ? "" : raw.slice(sp + 1),
	};
}

type Follower = { ac: AbortController; serviceId: string };

export function createDrains(
	docker: DockerClient,
	opts: {
		node: string;
		transport?: Transport;
		limits?: Partial<DrainLimits>;
		onError?: (msg: string, fields: Record<string, unknown>) => void;
	},
) {
	const limits = { ...DEFAULT_LIMITS, ...opts.limits };
	const transport = opts.transport ?? sendBatch;
	const shippers = new Map<string, DrainShipper>();
	const followers = new Map<string, Follower>();
	let routes: DrainsConfig["routes"] = {};
	// Containers running before the agent started already shipped (or not) under a previous run.
	const startedSec = Date.now() / 1000 - 5;
	let reconciling: Promise<void> | undefined;
	let again = false;

	const targets = (serviceId: string) =>
		(routes[serviceId]?.drainIds ?? [])
			.map((id) => shippers.get(id))
			.filter((s) => s !== undefined);

	async function follow(
		containerId: string,
		createdSec: number,
		labels: Record<string, string>,
		f: Follower,
	) {
		let since = Math.max(createdSec, startedSec);
		const deploymentId = labels["logistack.deployment"] ?? "";
		for (let attempt = 0; !f.ac.signal.aborted; attempt++) {
			try {
				const frames = await docker.containers.logs(containerId, {
					follow: true,
					timestamps: true,
					since,
					signal: f.ac.signal,
				});
				const split = lineSplitter();
				for await (const fr of frames) {
					const stream = fr.stream === "stderr" ? "stderr" : "stdout";
					for (const raw of split.push(stream, fr.data)) {
						const p = parseTimestamped(raw);
						if (!p) continue;
						since = (p.at + 1) / 1000;
						const route = routes[f.serviceId];
						if (!route) continue;
						const rec: LogRecord = {
							at: p.at,
							nanos: p.nanos,
							stream,
							line: p.line,
							meta: route.meta,
							deploymentId,
							node: opts.node,
						};
						let to = targets(f.serviceId);
						while (to.some((s) => s.congested) && !f.ac.signal.aborted) {
							await Bun.sleep(50);
							to = targets(f.serviceId);
						}
						for (const s of to) s.push(rec);
					}
				}
				return; // the container stopped
			} catch (e) {
				if (f.ac.signal.aborted) return;
				opts.onError?.("drain log stream failed", {
					containerId,
					error: errText(e),
				});
				await Bun.sleep(Math.min(30_000, 500 * 2 ** attempt));
			}
		}
	}

	async function reconcileOnce() {
		const wanted = new Map<
			string,
			{ created: number; labels: Record<string, string>; serviceId: string }
		>();
		if (Object.keys(routes).length > 0) {
			const running = await docker.containers.list({
				label: [`${LABEL_MANAGED}=true`],
				status: ["running"],
			});
			for (const c of running) {
				const serviceId = c.Labels[LABEL_RESOURCE];
				if (serviceId && targets(serviceId).length > 0)
					wanted.set(c.Id, { created: c.Created, labels: c.Labels, serviceId });
			}
		}
		for (const [id, f] of followers)
			if (!wanted.has(id)) {
				f.ac.abort();
				followers.delete(id);
			}
		for (const [id, w] of wanted) {
			if (followers.has(id)) continue;
			const f: Follower = { ac: new AbortController(), serviceId: w.serviceId };
			followers.set(id, f);
			void follow(id, w.created, w.labels, f).finally(() => {
				if (followers.get(id) === f) followers.delete(id);
			});
		}
	}

	/** Coalesces bursts of events into at most one pass in flight plus one queued. */
	function reconcile(): Promise<void> {
		if (reconciling) {
			again = true;
			return reconciling;
		}
		reconciling = (async () => {
			do {
				again = false;
				await reconcileOnce().catch((e) =>
					opts.onError?.("drain reconcile failed", { error: errText(e) }),
				);
			} while (again);
		})().finally(() => {
			reconciling = undefined;
		});
		return reconciling;
	}

	return {
		apply(config: DrainsConfig) {
			const ids = new Set(config.drains.map((d) => d.id));
			for (const [id, s] of shippers)
				if (!ids.has(id)) {
					s.close();
					shippers.delete(id);
				}
			for (const d of config.drains) {
				const s = shippers.get(d.id);
				if (s) s.config = d.config;
				else
					shippers.set(
						d.id,
						new DrainShipper(d.id, d.config, transport, limits),
					);
			}
			routes = config.routes;
			return reconcile();
		},
		/** Docker container start/die: the set of containers to follow may have changed. */
		containerEvent: () => void reconcile(),
		reconcile,
		statuses: () => [...shippers.values()].map((s) => s.snapshot()),
		get following() {
			return followers.size;
		},
		get heldBytes() {
			let n = 0;
			for (const s of shippers.values()) n += s.heldBytes;
			return n;
		},
		/** One synthetic line through `config`, from this node. */
		async test(
			config: LogDrainConfig,
			meta: LogMeta = TEST_META,
		): Promise<{ ok: boolean; status?: number; error?: string }> {
			const rec: LogRecord = {
				at: Date.now(),
				stream: "stdout",
				line: "LogiStack test event: this drain is reachable.",
				meta,
				deploymentId: "test",
				node: opts.node,
			};
			try {
				const r = await transport(
					encodeDrainBatch(config, [rec]),
					AbortSignal.timeout(limits.timeoutMs),
				);
				return { ok: true, status: r.status };
			} catch (e) {
				return {
					ok: false,
					status: e instanceof DrainHttpError ? e.status : undefined,
					error: errText(e),
				};
			}
		},
		close() {
			for (const f of followers.values()) f.ac.abort();
			followers.clear();
			for (const s of shippers.values()) s.close();
			shippers.clear();
		},
	};
}

export const TEST_META: LogMeta = {
	organizationId: "test",
	organization: "logistack",
	projectId: "test",
	project: "test",
	environmentId: "test",
	environment: "test",
	serviceId: "test",
	service: "logistack-test",
};

export type Drains = ReturnType<typeof createDrains>;
