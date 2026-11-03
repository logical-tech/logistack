import { hostname } from "node:os";
import {
	LIVE_CHANNEL,
	type LiveHostSample,
	type LiveMessage,
	METRICS_STREAM,
} from "@logistack/contracts";
import { RedisClient } from "bun";
import { log } from "./bus.ts";
import {
	type ContainerRow,
	type HostRow,
	insertRows,
	MetricsEntry,
	type Sql,
	toRows,
} from "./metrics-store.ts";

export const METRICS_GROUP = "ls-worker";
/** Latest host sample per node, read by the API for node cards. */
export const LAST_SAMPLE_KEY = (swarmNodeId: string) =>
	`ls:metrics:last:${swarmNodeId}`;

type Entry = [id: string, fields: string[]];

/** Bun's client speaks RESP3: XREADGROUP returns `{ stream: entries }`, XAUTOCLAIM `[next, entries, deleted]`. */
function entriesOf(reply: unknown): Entry[] {
	if (!reply) return [];
	if (Array.isArray(reply)) return (reply[1] as Entry[]) ?? [];
	// One stream per read, so the map has a single key.
	return (Object.values(reply as Record<string, Entry[]>)[0] ?? []).filter(
		(e) => Array.isArray(e[1]),
	);
}

function field(fields: string[], name: string): string | undefined {
	for (let i = 0; i < fields.length; i += 2)
		if (fields[i] === name) return fields[i + 1];
	return undefined;
}

export type NodeRef = { id: string; organizationId: string };

export type ConsumerOptions = {
	sql: Sql;
	redisUrl: string;
	stream?: string;
	group?: string;
	consumer?: string;
	/** Swarm node id -> its `node` row, for live samples; unknown nodes are stored but not pushed. */
	resolveNode?: (swarmNodeId: string) => Promise<NodeRef | undefined>;
	batch?: number;
	blockMs?: number;
	/** Pending entries idle this long on a dead consumer are claimed by this one. */
	claimIdleMs?: number;
};

export type Consumer = {
	/** Reads, stores and acks one batch; returns how many entries it handled. */
	poll(): Promise<number>;
	run(signal: AbortSignal): Promise<void>;
	close(): void;
};

/**
 * At-least-once consumer of `ls:metrics`: an entry is acked only after its rows are committed, so
 * a crash redelivers it (to this consumer on restart, or to another through XAUTOCLAIM) and the
 * primary keys make the second insert a no-op.
 */
export function createMetricsConsumer(opts: ConsumerOptions): Consumer {
	const stream = opts.stream ?? METRICS_STREAM;
	const group = opts.group ?? METRICS_GROUP;
	const consumer = opts.consumer ?? `${hostname()}-${process.pid}`;
	const batch = String(opts.batch ?? 500);
	// XREADGROUP BLOCK holds its connection, so publishing and claims use a second one.
	const reader = new RedisClient(opts.redisUrl);
	const redis = new RedisClient(opts.redisUrl);
	let ready = false;
	let backlog = true;
	let lastClaim = 0;

	async function ensureGroup() {
		if (ready) return;
		try {
			await redis.send("XGROUP", ["CREATE", stream, group, "0", "MKSTREAM"]);
		} catch (e) {
			if (!String(e).includes("BUSYGROUP")) throw e;
		}
		ready = true;
	}

	async function store(entries: Entry[]): Promise<void> {
		if (!entries.length) return;
		const host: HostRow[] = [];
		const containers: ContainerRow[] = [];
		const live: LiveHostSample[] = [];
		for (const [, fields] of entries) {
			const node = field(fields, "node");
			const parsed = MetricsEntry.safeParse(
				JSON.parse(field(fields, "data") ?? "null"),
			);
			if (!node || !parsed.success) {
				log("warn", "dropped malformed metrics entry", { node });
				continue;
			}
			// Partitions exist from yesterday on; a sample from a badly skewed clock has no home.
			if (Math.abs(parsed.data.at - Date.now()) > 86_400_000) {
				log("warn", "dropped metrics sample with a skewed clock", {
					node,
					at: parsed.data.at,
				});
				continue;
			}
			const rows = toRows(node, parsed.data);
			if (rows.host) host.push(rows.host);
			containers.push(...rows.containers);
			if (rows.host)
				live.push({
					nodeId: node,
					at: parsed.data.at,
					cpu: rows.host.cpu,
					load1: rows.host.load1,
					memUsed: rows.host.mem_used,
					memTotal: rows.host.mem_total,
					diskUsed: rows.host.disk_used,
					diskTotal: rows.host.disk_total,
					containers: rows.containers.length,
				});
		}
		await insertRows(opts.sql, host, containers);
		await redis.send("XACK", [stream, group, ...entries.map((e) => e[0])]);
		await publishLive(live);
	}

	async function publishLive(samples: LiveHostSample[]) {
		const latest = new Map<string, LiveHostSample>();
		for (const s of samples)
			if ((latest.get(s.nodeId)?.at ?? 0) < s.at) latest.set(s.nodeId, s);
		for (const [swarmId, s] of latest) {
			const ref = await opts.resolveNode?.(swarmId);
			const sample = { ...s, nodeId: ref?.id ?? swarmId };
			await redis.send("SET", [
				LAST_SAMPLE_KEY(swarmId),
				JSON.stringify(sample),
				"EX",
				"60",
			]);
			if (!ref) continue;
			const msg: LiveMessage = {
				kind: "host",
				channel: `org:${ref.organizationId}:metrics`,
				sample,
			};
			await redis.publish(LIVE_CHANNEL, JSON.stringify(msg));
		}
	}

	async function poll(): Promise<number> {
		await ensureGroup();
		const claimIdle = opts.claimIdleMs ?? 60_000;
		if (Date.now() - lastClaim > claimIdle) {
			lastClaim = Date.now();
			const claimed = entriesOf(
				await redis.send("XAUTOCLAIM", [
					stream,
					group,
					consumer,
					String(claimIdle),
					"0-0",
					"COUNT",
					batch,
				]),
			);
			await store(claimed);
		}
		// "0" re-reads this consumer's own unacked entries (left by a crash) before new ones.
		const read = (from: "0" | ">") =>
			reader.send("XREADGROUP", [
				"GROUP",
				group,
				consumer,
				"COUNT",
				batch,
				...(from === ">" ? ["BLOCK", String(opts.blockMs ?? 2_000)] : []),
				"STREAMS",
				stream,
				from,
			]);
		let entries = backlog ? entriesOf(await read("0")) : [];
		if (!entries.length) {
			backlog = false;
			entries = entriesOf(await read(">"));
		}
		await store(entries);
		return entries.length;
	}

	return {
		poll,
		async run(signal) {
			while (!signal.aborted) {
				try {
					await poll();
				} catch (e) {
					if (signal.aborted) return;
					log("error", "metrics consumer failed, retrying", {
						error: String(e),
					});
					backlog = true;
					await Bun.sleep(2_000);
				}
			}
		},
		close() {
			reader.close();
			redis.close();
		},
	};
}
