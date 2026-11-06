import {
	ACK_STALL_MS,
	type AgentMessage,
	type JobSpec,
	MAX_ARCHIVE_WRITE_BYTES,
	MAX_CHUNK_BYTES,
	MAX_LINE_BYTES,
	type RpcErrorCode,
	type ServerMessage,
} from "@logistack/contracts";
import {
	type DockerClient,
	DockerError,
	type ExecSession,
	type Frame,
	LABEL_MANAGED,
} from "@logistack/docker";
import { ArchiveRefused, listHostDirs, runArchive } from "./archive.ts";
import { runDisk } from "./disk.ts";
import { resolveTarget, TargetNotFoundError } from "./docker.ts";
import { BackpressureError, type Link } from "./link.ts";

class RpcError extends Error {
	constructor(
		readonly code: RpcErrorCode,
		message: string,
	) {
		super(message);
	}
}

interface Session {
	close(): void;
	stdin?(data: Uint8Array, eof: boolean): void;
	resize?(rows: number, cols: number): void;
	ack?(bytes: number): void;
}

const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64");
const outStream = (f: Frame) => (f.stream === "stderr" ? "stderr" : "stdout");

function* chunks(data: Uint8Array): Generator<Uint8Array> {
	for (let at = 0; at < data.length; at += MAX_CHUNK_BYTES)
		yield data.subarray(at, at + MAX_CHUNK_BYTES);
}

/** Splits frames into lines per stream; a line longer than MAX_LINE_BYTES is cut. */
export function lineSplitter() {
	const rest = { stdout: "", stderr: "" };
	const dec = { stdout: new TextDecoder(), stderr: new TextDecoder() };
	return {
		push(stream: "stdout" | "stderr", data: Uint8Array): string[] {
			let buf = rest[stream] + dec[stream].decode(data, { stream: true });
			const lines = buf.split("\n");
			buf = lines.pop() as string;
			const out: string[] = [];
			for (const l of lines) out.push(l.slice(0, MAX_LINE_BYTES));
			while (buf.length > MAX_LINE_BYTES) {
				out.push(buf.slice(0, MAX_LINE_BYTES));
				buf = buf.slice(MAX_LINE_BYTES);
			}
			rest[stream] = buf;
			return out;
		},
		flush(): ["stdout" | "stderr", string][] {
			const out: ["stdout" | "stderr", string][] = [];
			for (const s of ["stdout", "stderr"] as const)
				if (rest[s]) out.push([s, rest[s]]);
			rest.stdout = rest.stderr = "";
			return out;
		},
	};
}

function toRpcError(e: unknown): RpcError {
	if (e instanceof RpcError) return e;
	const message = e instanceof Error ? e.message : String(e);
	if (e instanceof TargetNotFoundError)
		return new RpcError("not_found", message);
	if (e instanceof ArchiveRefused) return new RpcError("bad_request", message);
	if (e instanceof BackpressureError)
		return new RpcError("backpressure", message);
	if (e instanceof DockerError)
		return new RpcError(e.notFound ? "not_found" : "docker", message);
	return new RpcError("internal", message);
}

/** Serves the server's requests on one connection; `closeAll` on disconnect. */
export function createSessions(
	docker: DockerClient,
	link: Link,
	hostRoot = "/",
) {
	const sessions = new Map<string, Session>();

	async function run(id: string, session: Session, body: () => Promise<void>) {
		if (sessions.has(id)) return;
		sessions.set(id, session);
		try {
			await body();
		} catch (e) {
			const err = toRpcError(e);
			// Terminal messages wait for the socket like output does; only telemetry is ever dropped.
			await link
				.sendStream({
					type: "rpc.error",
					id,
					code: err.code,
					message: err.message.slice(0, 4096),
				})
				.catch(() => {});
		} finally {
			sessions.delete(id);
			session.close();
		}
	}

	function startExec(m: Extract<ServerMessage, { type: "exec.start" }>) {
		const ac = new AbortController();
		let ready: Promise<ExecSession> | undefined;
		let chain = Promise.resolve();
		const session: Session = {
			close: () => ac.abort(),
			// stdin may arrive before the exec is up; the chain keeps writes in order.
			stdin(data, eof) {
				chain = chain
					.then(async () => {
						const s = await ready;
						if (!s) return;
						if (data.length) await s.write(data);
						if (eof) await s.closeStdin();
					})
					.catch(() => {});
			},
			resize(rows, cols) {
				ready?.then((s) => s.resize({ rows, cols })).catch(() => {});
			},
		};
		return run(m.id, session, async () => {
			ready = resolveTarget(docker, m.target).then((containerId) =>
				docker.containers.exec(containerId, {
					cmd: m.cmd,
					tty: m.tty,
					stdin: m.stdin,
					env: m.env,
					user: m.user,
					workingDir: m.workingDir,
					signal: ac.signal,
				}),
			);
			const s = await ready;
			if (m.tty && m.size) await s.resize(m.size);
			for await (const f of s.output)
				for (const c of chunks(f.data))
					await link.sendStream({
						type: "exec.output",
						id: m.id,
						stream: outStream(f),
						data: b64(c),
					});
			const code = ac.signal.aborted ? null : await s.exitCode();
			await link.sendStream({ type: "exec.exit", id: m.id, code });
		});
	}

	function followLogs(m: Extract<ServerMessage, { type: "logs.follow" }>) {
		const ac = new AbortController();
		return run(m.id, { close: () => ac.abort() }, async () => {
			const containerId = await resolveTarget(docker, m.target);
			const frames = await docker.containers.logs(containerId, {
				follow: true,
				tail: m.tail,
				since: m.since,
				timestamps: m.timestamps,
				signal: ac.signal,
			});
			const split = lineSplitter();
			const line = (stream: "stdout" | "stderr", text: string) =>
				link.sendStream({ type: "logs.line", id: m.id, stream, line: text });
			try {
				for await (const f of frames)
					for (const l of split.push(outStream(f), f.data))
						await line(outStream(f), l);
			} catch (e) {
				if (!ac.signal.aborted) throw e;
			}
			for (const [stream, l] of split.flush()) await line(stream, l);
			await link.sendStream({ type: "logs.end", id: m.id });
		});
	}

	function runJob(id: string, job: JobSpec) {
		const ac = new AbortController();
		let cancelled = false;
		let sent = 0;
		let acked = 0;
		/** Waits while the consumer is a full window behind; no-op without `ackWindowBytes`. */
		async function credit() {
			const window = job.ackWindowBytes;
			if (!window) return;
			const deadline = Date.now() + ACK_STALL_MS;
			while (sent - acked >= window && !ac.signal.aborted) {
				if (Date.now() > deadline)
					throw new RpcError(
						"backpressure",
						`the consumer acknowledged nothing for ${ACK_STALL_MS} ms`,
					);
				await Bun.sleep(20);
			}
		}
		return run(
			id,
			{
				close: () => {
					cancelled = true;
					ac.abort();
				},
				ack: (n) => {
					acked = Math.max(acked, n);
				},
			},
			async () => {
				const started = Date.now();
				const timer = setTimeout(() => ac.abort(), job.timeoutSec * 1000);
				let ephemeral: string | undefined;
				let result: AgentMessage;
				try {
					let containerId: string;
					if (job.kind === "exec") {
						containerId = await resolveTarget(docker, job.target);
					} else {
						containerId = ephemeral = await createJobContainer(docker, job);
					}
					const s = await docker.containers.exec(containerId, {
						cmd: job.cmd,
						stdin: job.script !== undefined,
						env: job.env,
						user: job.kind === "exec" ? job.user : undefined,
						workingDir: job.kind === "exec" ? job.workingDir : undefined,
						signal: ac.signal,
					});
					if (job.script !== undefined) {
						await s.write(job.script);
						await s.closeStdin();
					}
					let bytes = 0;
					for await (const f of s.output) {
						const room = job.outputLimitBytes - bytes;
						bytes += f.data.length;
						if (room <= 0) continue;
						for (const c of chunks(f.data.subarray(0, room))) {
							await link.sendStream({
								type: "job.output",
								id,
								stream: outStream(f),
								data: b64(c),
							});
							sent += c.length;
							await credit();
						}
					}
					if (ac.signal.aborted)
						// shortcut: for `exec` jobs the engine has no exec kill, so the process may outlive the stream; add a pkill exec when a real job needs it.
						throw cancelled
							? new RpcError("cancelled", "job cancelled")
							: new RpcError("timeout", `job exceeded ${job.timeoutSec}s`);
					result = {
						type: "job.result",
						id,
						exitCode: await s.exitCode(),
						bytes,
						truncated: bytes > job.outputLimitBytes,
						durationMs: Date.now() - started,
					};
				} finally {
					clearTimeout(timer);
					if (ephemeral)
						await docker.containers.remove(ephemeral, true).catch(() => {});
				}
				await link.sendStream(result);
			},
		);
	}

	function disk(m: Extract<ServerMessage, { type: "disk.run" }>) {
		// The engine API has no way to cancel a df or prune midway; closing only drops the reply.
		return run(m.id, { close: () => {} }, async () => {
			const r = await runDisk(docker, hostRoot, m.request);
			await link.sendStream({ type: "disk.result", id: m.id, ...r });
		});
	}

	function archive(m: Extract<ServerMessage, { type: "archive.start" }>) {
		const req = m.request;
		if (req.op === "host-dirs")
			return run(m.id, { close: () => {} }, async () => {
				const result = await listHostDirs(hostRoot, req.path);
				await link.sendStream({ type: "archive.result", id: m.id, ...result });
			});
		const ac = new AbortController();
		const parts: Uint8Array[] = [];
		let size = 0;
		const uploaded = Promise.withResolvers<void>();
		const session: Session = {
			close() {
				ac.abort();
				uploaded.reject(new RpcError("cancelled", "request cancelled"));
			},
			stdin(data, eof) {
				size += data.length;
				if (size > MAX_ARCHIVE_WRITE_BYTES)
					return uploaded.reject(
						new RpcError(
							"bad_request",
							`the upload exceeds ${MAX_ARCHIVE_WRITE_BYTES} bytes`,
						),
					);
				parts.push(new Uint8Array(data));
				if (eof) uploaded.resolve();
			},
		};
		uploaded.promise.catch(() => {});
		return run(m.id, session, async () => {
			const containerId = await resolveTarget(docker, req.target);
			const result = await runArchive(docker, containerId, req, {
				signal: ac.signal,
				onData: async (data) => {
					for (const c of chunks(data))
						await link.sendStream({
							type: "archive.data",
							id: m.id,
							data: b64(c),
						});
				},
				upload: async () => {
					await uploaded.promise;
					return Buffer.concat(parts);
				},
			});
			await link.sendStream({ type: "archive.result", id: m.id, ...result });
		});
	}

	return {
		handle(m: ServerMessage): void {
			switch (m.type) {
				case "heartbeat":
					return;
				case "exec.start":
					void startExec(m);
					return;
				case "exec.stdin":
					sessions.get(m.id)?.stdin?.(Buffer.from(m.data, "base64"), m.eof);
					return;
				case "exec.resize":
					sessions.get(m.id)?.resize?.(m.rows, m.cols);
					return;
				case "logs.follow":
					void followLogs(m);
					return;
				case "run.job":
					void runJob(m.id, m.job);
					return;
				case "disk.run":
					void disk(m);
					return;
				case "archive.start":
					void archive(m);
					return;
				case "job.ack":
					sessions.get(m.id)?.ack?.(m.bytes);
					return;
				case "exec.close":
				case "logs.stop":
				case "job.cancel":
					sessions.get(m.id)?.close();
					return;
			}
		},
		get size() {
			return sessions.size;
		},
		closeAll() {
			for (const s of sessions.values()) s.close();
		},
	};
}

/**
 * Starts a fresh container that idles on `sh` reading its open stdin, so the job itself can run
 * as an exec with the script on stdin and a real exit code.
 */
// shortcut: needs `sh` in the image; switch to a hijacked attach once @logistack/docker exposes one.
async function createJobContainer(
	docker: DockerClient,
	job: Extract<JobSpec, { kind: "container" }>,
): Promise<string> {
	try {
		await docker.images.inspect(job.image);
	} catch (e) {
		if (!(e instanceof DockerError && e.notFound)) throw e;
		await docker.images.pull(job.image);
	}
	const { Id } = await docker.containers.create(job.containerName, {
		Image: job.image,
		Entrypoint: ["sh"],
		Cmd: [],
		OpenStdin: true,
		Env: job.env,
		Labels: { ...job.labels, [LABEL_MANAGED]: "true" },
		HostConfig: {
			Mounts: job.mounts.map((m) => ({
				Type: m.type,
				Source: m.source,
				Target: m.target,
				ReadOnly: m.readOnly,
			})),
			NetworkMode: job.network,
		},
	});
	try {
		await docker.containers.start(Id);
	} catch (e) {
		await docker.containers.remove(Id, true).catch(() => {});
		throw e;
	}
	return Id;
}

export type Sessions = ReturnType<typeof createSessions>;
