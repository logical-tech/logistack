import {
	LIVE_CHANNEL,
	type LiveMessage,
	type NodeJoinState,
} from "@logistack/contracts";
import { decrypt, nodeLabels } from "@logistack/core";
import { node, nodeJoin, sshKey } from "@logistack/db";
import { eq, sql } from "drizzle-orm";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import {
	bootstrapScript,
	parseKv,
	parsePreflight,
	preflightScript,
	TEST_SCRIPT,
} from "./node-scripts.ts";
import { runSsh } from "./ssh.ts";

type JoinRow = typeof nodeJoin.$inferSelect;

/** A step left `running` this long belongs to a dead worker and is queued again. */
const STALE_RUN = "15 minutes";
const SWARM_WAIT_MS = 120_000;
const AGENT_WAIT_MS = 180_000;

/** Atomically takes one queued (or abandoned) step, so replicas never run the same one twice. */
export async function claimJoin(ctx: Ctx): Promise<JoinRow | undefined> {
	const rows = await ctx.db.execute<{ id: string }>(sql`
		update node_join set state = 'running', claimed_at = now(), error = null, updated_at = now()
		where id = (
			select id from node_join
			where state = 'queued' or (state = 'running' and claimed_at < now() - ${STALE_RUN}::interval)
			order by updated_at limit 1 for update skip locked
		)
		returning id`);
	const id = rows[0]?.id;
	if (!id) return undefined;
	const [row] = await ctx.db.select().from(nodeJoin).where(eq(nodeJoin.id, id));
	return row;
}

function reporter(ctx: Ctx, row: JoinRow) {
	const channel = `node-join:${row.id}`;
	const push = (m: Omit<Extract<LiveMessage, { kind: "join" }>, "kind">) =>
		ctx.bus.redis.publish(
			LIVE_CHANNEL,
			JSON.stringify({ kind: "join", ...m } satisfies LiveMessage),
		);
	// Lines are appended in order even though ssh output callbacks do not wait.
	let tail = Promise.resolve();
	const append = async (line: string) => {
		await ctx.db
			.update(nodeJoin)
			.set({ log: sql`${nodeJoin.log} || ${JSON.stringify([line])}::jsonb` })
			.where(eq(nodeJoin.id, row.id));
		await push({ channel, line, step: row.step, state: "running" });
	};
	return {
		line(text: string) {
			const line = text.replace(/\s+$/, "");
			if (line) tail = tail.then(() => append(line)).catch(() => {});
			return tail;
		},
		async finish(
			state: Exclude<NodeJoinState, "queued" | "running">,
			set: Partial<JoinRow> = {},
		) {
			await tail;
			await ctx.db
				.update(nodeJoin)
				.set({ ...set, state })
				.where(eq(nodeJoin.id, row.id));
			await push({ channel, step: row.step, state });
		},
	};
}

/** Runs the claimed step and records its outcome; never throws. */
export async function runJoinStep(ctx: Ctx, row: JoinRow): Promise<void> {
	const out = reporter(ctx, row);
	try {
		const [key] = await ctx.db
			.select({ enc: sshKey.privateKeyEncrypted })
			.from(sshKey)
			.where(eq(sshKey.id, row.sshKeyId));
		if (!key) throw new Error("the SSH key was deleted");
		const privateKey = await decrypt(ctx.masterKey, key.enc);
		const target = { host: row.host, port: row.port, user: row.sshUser };
		const ssh = (script: string, stream: boolean, timeoutMs?: number) =>
			runSsh(target, privateKey, script, {
				hostKey: row.hostKey,
				timeoutMs,
				onLine: stream ? (l) => void out.line(l) : undefined,
			});
		const failed = (stderr: string) =>
			stderr.trim().split("\n").at(-1) || "ssh exited with an error";

		if (row.step === "test") {
			await out.line(`Connecting to ${row.sshUser}@${row.host}:${row.port}`);
			const res = await ssh(TEST_SCRIPT, false, 30_000);
			if (res.code !== 0)
				return out.finish("failed", { error: failed(res.stderr) });
			const kv = parseKv(res.stdout);
			await out.line(`Connected as ${kv.user} on ${kv.system}`);
			if (kv.privileges === "none")
				return out.finish("failed", {
					error: `${kv.user} needs root or passwordless sudo`,
					hostKey: res.hostKey,
				});
			return out.finish("succeeded", { hostKey: res.hostKey });
		}

		const info = await ctx.docker.info();
		const managerHost = info.Swarm.NodeAddr;
		if (!managerHost) throw new Error("this server is not a swarm manager");

		if (row.step === "preflight") {
			const res = await ssh(
				preflightScript({ host: managerHost, port: 2377 }),
				false,
				60_000,
			);
			if (res.code !== 0)
				return out.finish("failed", { error: failed(res.stderr) });
			const checks = parsePreflight(res.stdout);
			const blocking = checks.filter((c) => c.status === "fail");
			return out.finish(blocking.length ? "failed" : "succeeded", {
				checks,
				error: blocking.length
					? `${blocking.map((c) => c.label).join(", ")} must be fixed first`
					: null,
			});
		}

		const tokens = await ctx.docker.swarm.joinTokens();
		const res = await ssh(
			bootstrapScript({
				token: row.role === "manager" ? tokens.Manager : tokens.Worker,
				manager: `${managerHost}:2377`,
				role: row.role,
			}),
			true,
			15 * 60_000,
		);
		const swarmNodeId = parseKv(res.stdout).LS_NODE_ID;
		if (res.code !== 0 || !swarmNodeId)
			return out.finish("failed", { error: failed(res.stderr) });
		await out.line(
			`Waiting for node ${swarmNodeId.slice(0, 12)} to be ready in the swarm`,
		);
		const dn = await waitFor(SWARM_WAIT_MS, async () => {
			const n = await ctx.docker.nodes
				.inspect(swarmNodeId)
				.catch(() => undefined);
			return n?.Status.State === "ready" ? n : undefined;
		});
		if (!dn)
			return out.finish("failed", {
				error: "the node did not become ready in the swarm",
				swarmNodeId,
			});
		const labels = nodeLabels(
			{ ...dn.Spec.Labels, ...row.labels },
			dn.Spec.Labels ?? {},
		);
		await ctx.docker.nodes.update(dn.ID, dn.Version.Index, {
			...dn.Spec,
			Labels: labels,
		});
		const [saved] = await ctx.db
			.insert(node)
			.values({
				organizationId: row.organizationId,
				swarmNodeId,
				hostname: dn.Description.Hostname,
				address: dn.Status.Addr,
				role: dn.Spec.Role,
				labels,
			})
			.onConflictDoUpdate({
				target: node.swarmNodeId,
				set: { labels, desired: "active" },
			})
			.returning({ id: node.id });
		await out.line("Node is ready; waiting for its agent to report");
		const agent = await waitFor(AGENT_WAIT_MS, async () =>
			(await ctx.bus.redis.exists(`ls:nodes:${swarmNodeId}`))
				? true
				: undefined,
		);
		await out.line(
			agent
				? "Agent is reporting"
				: "The agent has not reported yet; the node shows as pending until it does",
		);
		return out.finish("succeeded", { swarmNodeId, nodeId: saved?.id ?? null });
	} catch (e) {
		log("error", "node join step failed", {
			id: row.id,
			step: row.step,
			error: String(e),
		});
		await out.finish("failed", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function waitFor<T>(
	ms: number,
	probe: () => Promise<T | undefined>,
): Promise<T | undefined> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = await probe();
		if (v !== undefined) return v;
		if (Date.now() > deadline) return undefined;
		await Bun.sleep(2_000);
	}
}
