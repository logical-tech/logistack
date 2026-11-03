import { z } from "@hono/zod-openapi";
import type { NodeExec } from "@logistack/worker/node-runner";
import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { authenticate, requireActor } from "./actor.ts";
import { recordAudit } from "./audit.ts";
import type { Env } from "./env.ts";
import { Failure } from "./errors.ts";
import { parseJson } from "./events.ts";
import { redisFor } from "./redis.ts";
import { ExecTicket, execTicketKey } from "./routes/service-ops.ts";

const Control = z.discriminatedUnion("type", [
	z.object({ type: z.literal("input"), data: z.string().max(65_536) }),
	z.object({
		type: z.literal("resize"),
		rows: z.int().min(2).max(500),
		cols: z.int().min(2).max(1000),
	}),
]);

/** Server to browser text frames; TTY output travels as binary frames. */
export type ExecServerMessage =
	| { type: "ready"; taskId: string }
	| { type: "exit"; code: number | null }
	| { type: "error"; message: string };

async function toBytes(data: unknown): Promise<Uint8Array | undefined> {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
	return undefined;
}

/**
 * Browser terminal over `deps.nodes.exec`: a ticket from `POST /services/{id}/exec` (which checks
 * `exec` and audits the start) is redeemed once, by the same actor, within 30 seconds.
 */
export const terminal = new Hono<Env>().get(
	"/ws/exec",
	authenticate,
	async (c, next) => {
		const actor = requireActor(c);
		const raw = await redisFor(c.var.deps.config.REDIS_URL).getdel(
			execTicketKey(c.req.query("ticket") ?? ""),
		);
		const ticket = ExecTicket.safeParse(raw && parseJson(raw));
		if (
			!ticket.success ||
			ticket.data.actorId !== actor.id ||
			ticket.data.organizationId !== actor.organizationId
		)
			throw new Failure("forbidden", "invalid or expired terminal ticket");
		c.set("auditResourceId", ticket.data.serviceId);
		c.set("auditDiff", ticket.data);
		await next();
	},
	upgradeWebSocket((c: Context<Env>) => {
		const t = c.get("auditDiff") as ExecTicket;
		const started = Date.now();
		let exitCode: number | null = null;
		let exec: NodeExec | undefined;
		return {
			onOpen(_evt, ws) {
				const text = (m: ExecServerMessage) => ws.send(JSON.stringify(m));
				const session = c.var.deps.nodes.exec(t.nodeId, {
					target: { kind: "task", taskId: t.taskId },
					cmd: [t.shell],
					tty: true,
					stdin: true,
					env: ["TERM=xterm-256color"],
					size: { rows: t.rows, cols: t.cols },
				});
				exec = session;
				text({ type: "ready", taskId: t.taskId });
				void (async () => {
					try {
						for await (const chunk of session)
							ws.send(new Uint8Array(chunk.data));
						exitCode = (await session.result).code;
						text({ type: "exit", code: exitCode });
					} catch (e) {
						text({
							type: "error",
							message: e instanceof Error ? e.message : String(e),
						});
					}
					ws.close(1000);
				})();
			},
			async onMessage(evt) {
				if (!exec) return;
				const bytes = await toBytes(evt.data);
				if (bytes) return void exec.write(bytes).catch(() => {});
				const m = Control.safeParse(
					typeof evt.data === "string" ? parseJson(evt.data) : undefined,
				);
				if (!m.success) return;
				if (m.data.type === "input")
					void exec.write(m.data.data).catch(() => {});
				else void exec.resize(m.data.rows, m.data.cols).catch(() => {});
			},
			async onClose() {
				exec?.close();
				await recordAudit(c, {
					action: "service.exec_end",
					resourceId: t.serviceId,
					diff: {
						taskId: t.taskId,
						nodeId: t.nodeId,
						shell: t.shell,
						exitCode,
						durationMs: Date.now() - started,
					},
					outcome: "success",
				});
			},
		};
	}),
);
