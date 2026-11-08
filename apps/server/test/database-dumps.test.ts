import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ExecStartInput, JobSpecInput } from "@logistack/contracts";
import { dumpScript, restoreScript } from "@logistack/core";
import { auditLog, serviceStatus } from "@logistack/db";
import type {
	NodeExec,
	NodeRunner,
	OutputChunk,
} from "@logistack/worker/node-runner";
import { desc, eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const out = (s: string): OutputChunk => ({ stream: "stdout", data: enc(s) });
const err = (s: string): OutputChunk => ({ stream: "stderr", data: enc(s) });

/** What the fake node answers: output chunks then an exit code. */
type Plan = { chunks: OutputChunk[]; code: number };

describe.skipIf(!hasDocker)("database dump and restore API", () => {
	let h: Harness;
	let cookie: string;
	let developer: string;
	let envId: string;
	let pgId: string;
	let redisId: string;
	let real: NodeRunner;
	let plan: Plan = { chunks: [], code: 0 };
	const jobs: { nodeId: string; job: JobSpecInput }[] = [];
	const execs: {
		nodeId: string;
		req: ExecStartInput;
		input: Uint8Array[];
		ended: boolean;
	}[] = [];

	const fake: NodeRunner = {
		runJob(nodeId, job) {
			jobs.push({ nodeId, job });
			const { chunks, code } = plan;
			let settle!: (r: { code: number }) => void;
			const exit = new Promise<{ code: number }>((r) => {
				settle = r;
			});
			async function* gen() {
				for (const c of chunks) {
					await Bun.sleep(1);
					yield c;
				}
				settle({ code });
			}
			return Object.assign(gen(), {
				result: exit.then((e) => ({
					exitCode: e.code,
					bytes: 0,
					truncated: false,
					durationMs: 1,
				})),
			});
		},
		exec(nodeId, req) {
			const rec = { nodeId, req, input: [] as Uint8Array[], ended: false };
			execs.push(rec);
			const { chunks, code } = plan;
			let finish!: () => void;
			const eof = new Promise<void>((r) => {
				finish = r;
			});
			async function* gen() {
				await eof;
				yield* chunks;
			}
			const session: NodeExec = Object.assign(gen(), {
				result: eof.then(() => ({ code })),
				write: async (d: string | Uint8Array) => {
					rec.input.push(typeof d === "string" ? enc(d) : d);
				},
				end: async () => {
					rec.ended = true;
					finish();
				},
				resize: async () => {},
				close: () => finish(),
			});
			return session;
		},
		followLogs: () => {
			throw new Error("not used");
		},
		disk: () => {
			throw new Error("not used");
		},
		archive: () => {
			throw new Error("not used");
		},
		testDrain: () => {
			throw new Error("not used");
		},
		close: () => {},
	};

	const running = (id: string, taskId: string) =>
		h.deps.db
			.insert(serviceStatus)
			.values({
				serviceId: id,
				observed: "running",
				tasks: [
					{
						id: taskId,
						slot: 1,
						nodeId: "node-a",
						state: "running",
						error: null,
					},
				],
			})
			.onConflictDoNothing();
	const create = async (name: string, engine: string, version: string) =>
		(
			await h.call("POST", `/api/environments/${envId}/services`, {
				headers: { cookie },
				body: {
					name,
					spec: {
						kind: "database",
						engine,
						version,
						credentialsRef: "env",
						resources: {},
					},
				},
			})
		).json.id as string;
	const dump = (id: string, who = cookie, method = "GET") =>
		h.app.request(`/api/databases/${id}/dump`, {
			method,
			headers: { cookie: who },
		});
	const restore = (
		id: string,
		body: Uint8Array | ReadableStream<Uint8Array>,
		who = cookie,
		headers: Record<string, string> = {},
	) =>
		h.app.request(`/api/databases/${id}/restore`, {
			method: "POST",
			headers: {
				cookie: who,
				origin: h.config.WEB_ORIGIN,
				"content-type": "application/octet-stream",
				...headers,
			},
			body,
			duplex: "half",
		});
	const audits = (action: string) =>
		h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, action))
			.orderBy(desc(auditLog.at));

	beforeAll(async () => {
		h = await startHarness({ area: "dbx5", label: "dbx5" });
		real = h.deps.nodes;
		h.deps.nodes = fake;
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const prj = await h.call("POST", "/api/projects", {
			headers: { cookie },
			body: { name: "Shop" },
		});
		envId = (
			await h.call("GET", `/api/projects/${prj.json.id}/environments`, {
				headers: { cookie },
			})
		).json[0].id;
		pgId = await create("orders-db", "postgres", "18-alpine");
		redisId = await create("cache", "redis", "8-alpine");
		await running(pgId, "task-pg");
		await running(redisId, "task-redis");

		const user = { name: "dev", email: "dev@example.com" };
		const password = "developer password 12";
		const invite = await h.call("POST", "/api/invitations", {
			headers: { cookie },
			body: { email: user.email, role: "developer" },
		});
		expect(invite.status).toBe(201);
		await h.call("POST", "/api/auth/sign-up/email", {
			body: { ...user, password },
		});
		developer = await h.signIn(user.email, password);
		await h.call("POST", "/api/auth/organization/accept-invitation", {
			headers: { cookie: developer },
			body: { invitationId: invite.json.id },
		});
	}, 90_000);
	afterAll(async () => {
		if (h) h.deps.nodes = real;
		await h?.close();
	});

	test("a dump streams every stdout chunk in order as a named attachment", async () => {
		plan = {
			chunks: [out("PGDMP-1|"), err("pg_dump: note\n"), out("2|"), out("3")],
			code: 0,
		};
		const res = await dump(pgId);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toMatch(
			/^attachment; filename\*=UTF-8''orders-db-\d{8}-\d{6}\.dump$/,
		);
		expect(res.headers.get("content-length")).toBeNull();
		expect(await res.text()).toBe("PGDMP-1|2|3");
		expect(jobs.at(-1)).toEqual({
			nodeId: "node-a",
			job: expect.objectContaining({
				kind: "exec",
				target: { kind: "task", taskId: "task-pg" },
				script: dumpScript("postgres"),
			}),
		});
		const [row] = await audits("database.dump");
		expect(row).toMatchObject({ resourceId: pgId, outcome: "success" });
		expect(row?.diff).toMatchObject({ bytes: 11, taskId: "task-pg" });
	});

	test("a dump that fails mid-stream errors the body instead of ending clean", async () => {
		plan = {
			chunks: [out("PGDMP-partial"), err("pg_dump: error: connection lost")],
			code: 1,
		};
		const res = await dump(pgId);
		expect(res.status).toBe(200);
		await expect(res.text()).rejects.toThrow(/exit 1: pg_dump: error/);
		await Bun.sleep(20);
		const [row] = await audits("database.dump");
		expect(row).toMatchObject({ outcome: "error" });
		expect(row?.diff).toMatchObject({ bytes: 13 });
	});

	test("a dump that fails before its first byte is a 409 with stderr", async () => {
		plan = {
			chunks: [err('pg_dump: error: password authentication failed for "x"')],
			code: 1,
		};
		const res = await dump(pgId);
		expect(res.status).toBe(409);
		const body = (await res.json()) as {
			error: { details: { reason: string; exitCode: number; stderr: string } };
		};
		expect(body.error.details).toMatchObject({
			reason: "tool_failed",
			exitCode: 1,
		});
		expect(body.error.details.stderr).toContain("authentication failed");
	});

	test("dumping needs read:secrets; HEAD checks it without dumping", async () => {
		const before = jobs.length;
		expect((await dump(pgId, developer)).status).toBe(403);
		expect((await dump(pgId, developer, "HEAD")).status).toBe(403);
		expect((await dump(pgId, cookie, "HEAD")).status).toBe(200);
		expect(jobs.length).toBe(before);
	});

	test("redis dumps as .rdb, and a database with no running replica is a 409", async () => {
		plan = { chunks: [out("REDIS0011")], code: 0 };
		const res = await dump(redisId);
		expect(res.headers.get("content-disposition")).toMatch(/cache-.*\.rdb$/);
		expect(await res.text()).toBe("REDIS0011");
		expect(jobs.at(-1)?.job).toMatchObject({ script: dumpScript("redis") });

		const idle = await create("idle-db", "postgres", "18-alpine");
		const r = await dump(idle);
		expect(r.status).toBe(409);
		expect(
			((await r.json()) as { error: { details: unknown } }).error.details,
		).toEqual({
			reason: "not_running",
		});
	});

	test("restore pipes the body, chunk by chunk, into the restore tool's stdin", async () => {
		plan = { chunks: [], code: 0 };
		const parts = ["PGDMP", "-chunk-two", "-chunk-three"];
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				for (const p of parts) c.enqueue(enc(p));
				c.close();
			},
		});
		const res = await restore(pgId, body, cookie, { "content-length": "27" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytes: 27 });
		const rec = execs.at(-1);
		expect(rec?.req).toEqual({
			target: { kind: "task", taskId: "task-pg" },
			cmd: ["sh", "-c", restoreScript("postgres")],
			stdin: true,
		});
		expect(new TextDecoder().decode(Buffer.concat(rec?.input ?? []))).toBe(
			parts.join(""),
		);
		expect(rec?.ended).toBe(true);
		const [row] = await audits("database.restore");
		expect(row).toMatchObject({ resourceId: pgId, outcome: "success" });
		expect(row?.diff).toEqual({ size: 27 });
	});

	test("a failing restore is a 409 with the exit code and stderr tail", async () => {
		plan = {
			chunks: [err("pg_restore: error: input file appears to be corrupt")],
			code: 1,
		};
		const res = await restore(pgId, enc("not a dump"));
		expect(res.status).toBe(409);
		const body = (await res.json()) as {
			error: { message: string; details: { exitCode: number; stderr: string } };
		};
		expect(body.error.message).toBe("the restore failed (exit 1)");
		expect(body.error.details.exitCode).toBe(1);
		expect(body.error.details.stderr).toContain("corrupt");
		const [row] = await audits("database.restore");
		expect(row?.outcome).toBe("error");
	});

	test("restore needs admin and is refused for redis", async () => {
		const before = execs.length;
		const denied = await restore(pgId, enc("x"), developer);
		expect(denied.status).toBe(403);
		const [row] = await audits("database.restore");
		expect(row?.outcome).toBe("denied");
		const r = await restore(redisId, enc("REDIS"));
		expect(r.status).toBe(400);
		expect(
			((await r.json()) as { error: { message: string } }).error.message,
		).toBe("restore is not supported for redis");
		expect(execs.length).toBe(before);
	});
});
