import { readFile } from "node:fs/promises";
import { z } from "@hono/zod-openapi";
import {
	DeploymentLogLine,
	deploymentLogChannel,
	deploymentLogKey,
} from "@logistack/contracts";
import { isTerminal } from "@logistack/core";
import { deployment, serviceStatus } from "@logistack/db";
import { RedisClient } from "bun";
import { eq } from "drizzle-orm";
import type { Deps } from "./env.ts";
import { parseJson } from "./events.ts";
import { redisFor } from "./redis.ts";
import { TaskView } from "./routes/service-ops.ts";

/** Options a client sends with a `service-logs:<id>` subscription. */
export const LogOptions = z.object({
	/** Lines per replica before following. */
	tail: z.union([z.int().min(0).max(10_000), z.literal("all")]).default(200),
	/** Unix seconds. */
	since: z.int().nonnegative().optional(),
	/** One replica; all running ones when absent. */
	taskId: z.string().optional(),
});
export type LogOptions = z.infer<typeof LogOptions>;

export type StreamMessage =
	| {
			type: "line";
			channel: string;
			line: string;
			/** Deployment logs: the line's index in the stored log. */
			seq?: number;
			/** Runtime logs: which replica, which stream. */
			taskId?: string;
			slot?: number | null;
			stream?: "stdout" | "stderr";
			at?: string;
	  }
	/** Nothing more will come on this subscription (a finished deployment, a stopped replica). */
	| { type: "end"; channel: string; reason: string };

type Send = (m: StreamMessage) => void;

/**
 * Replays a deployment's stored log, then follows it live. Subscribes before reading the list,
 * so every line is either in the list or published after it; `seq` drops the overlap.
 */
export async function followDeploymentLog(
	deps: Pick<Deps, "db" | "config">,
	id: string,
	channel: string,
	send: Send,
): Promise<() => void> {
	const sub = new RedisClient(deps.config.REDIS_URL);
	let next = -1;
	const early: DeploymentLogLine[] = [];
	const emit = (m: DeploymentLogLine) => {
		if (m.seq < next) return;
		next = m.seq + 1;
		send({ type: "line", channel, line: m.line, seq: m.seq, at: m.at });
	};
	await sub.subscribe(deploymentLogChannel(id), (raw: string) => {
		const m = DeploymentLogLine.safeParse(parseJson(raw));
		if (!m.success) return;
		if (next < 0) early.push(m.data);
		else emit(m.data);
	});
	const stored = await redisFor(deps.config.REDIS_URL).lrange(
		deploymentLogKey(id),
		0,
		-1,
	);
	const [row] = await deps.db
		.select({ status: deployment.status, logPath: deployment.logPath })
		.from(deployment)
		.where(eq(deployment.id, id));
	let lines = stored.map((raw, seq) => {
		const v = parseJson(raw) as { line?: unknown; at?: unknown } | undefined;
		return {
			seq,
			line: typeof v?.line === "string" ? v.line : "",
			at: typeof v?.at === "string" ? v.at : "",
		};
	});
	// Expired from Redis: the worker's file, readable when the api shares its volume (single host, dev).
	if (lines.length === 0 && row?.logPath)
		lines = (await readFile(row.logPath, "utf8").catch(() => ""))
			.split("\n")
			.slice(0, -1)
			.map((line, seq) => ({ seq, line, at: "" }));
	next = 0;
	for (const m of lines) emit(m);
	for (const m of early.sort((a, b) => a.seq - b.seq)) emit(m);
	if (!row || isTerminal(row.status)) {
		sub.close();
		send({ type: "end", channel, reason: row ? row.status : "not found" });
		return () => {};
	}
	return () => sub.close();
}

/** Docker's `timestamps` prefix: RFC 3339 with nanoseconds, then a space. */
const TIMESTAMPED = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/s;

/**
 * Follows the runtime logs of every running replica (or one) on whichever node runs it,
 * through the agent bridge. Each replica's stream ends on its own when its container stops.
 */
export async function followServiceLogs(
	deps: Pick<Deps, "db" | "nodes">,
	serviceId: string,
	channel: string,
	opts: LogOptions,
	send: Send,
): Promise<() => void> {
	const [row] = await deps.db
		.select({ tasks: serviceStatus.tasks })
		.from(serviceStatus)
		.where(eq(serviceStatus.serviceId, serviceId));
	const tasks = z
		.array(TaskView)
		.catch([])
		.parse(row?.tasks ?? [])
		.filter(
			(t) =>
				t.nodeId &&
				t.state === "running" &&
				(!opts.taskId || t.id === opts.taskId),
		);
	if (tasks.length === 0) {
		send({ type: "end", channel, reason: "no running replica" });
		return () => {};
	}
	const ac = new AbortController();
	let open = tasks.length;
	for (const t of tasks)
		void (async () => {
			let reason = "stopped";
			try {
				const lines = deps.nodes.followLogs(
					t.nodeId as string,
					{
						target: { kind: "task", taskId: t.id },
						tail: opts.tail,
						...(opts.since !== undefined ? { since: opts.since } : {}),
						timestamps: true,
					},
					{ signal: ac.signal },
				);
				for await (const l of lines) {
					const m = TIMESTAMPED.exec(l.line);
					send({
						type: "line",
						channel,
						line: m ? (m[2] as string) : l.line,
						...(m ? { at: m[1] } : {}),
						stream: l.stream,
						taskId: t.id,
						slot: t.slot,
					});
				}
			} catch (e) {
				reason = e instanceof Error ? e.message : String(e);
			}
			if (ac.signal.aborted) return;
			if (--open === 0) send({ type: "end", channel, reason });
		})();
	return () => ac.abort();
}
