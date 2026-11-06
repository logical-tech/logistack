/*
 * A running container's filesystem, browsed through the engine's archive endpoint on the node that
 * runs the replica: no process starts in the container, so it works in images without a shell.
 * The daemon reads and writes as root, which makes this as powerful as exec: every route needs
 * the `exec` permission and uploads are audited.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
	type ArchiveRequest,
	ArchiveResult,
	MAX_ARCHIVE_READ_BYTES,
	normalizeContainerPath,
} from "@logistack/contracts";
import { buildTar, safeRelativePath } from "@logistack/docker";
import { NodeRunnerError } from "@logistack/worker/node-runner";
import type { Context } from "hono";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure } from "../errors.ts";
import { errors, json, router, security } from "../openapi.ts";
import { byParam, requirePermission } from "../scope.ts";
import { MAX_UPLOAD_BYTES } from "./files.ts";
import { runningTask } from "./service-ops.ts";

const tags = ["services"];
/** Text shown inline; bigger files are cut and flagged `truncated`. */
export const VIEW_LIMIT_BYTES = 1024 * 1024;

const Params = z.object({ id: z.string() });
const Query = z.object({
	/** Defaults to the first running replica. */
	taskId: z.string().max(64).optional(),
	path: z.string().min(1).max(4096),
});

const Listing = ArchiveResult.extend({ taskId: z.string() }).openapi(
	"ContainerListing",
);
const FileContent = z
	.object({
		taskId: z.string(),
		path: z.string(),
		size: z.int(),
		/** Content past 1 MB was cut. */
		truncated: z.boolean(),
		/** The first 1 MB holds a NUL byte; `content` is null. */
		binary: z.boolean(),
		content: z.string().nullable(),
	})
	.openapi("ContainerFileContent");

const exec = requirePermission("exec", byParam("service"));

function containerPath(raw: string) {
	try {
		return normalizeContainerPath(raw);
	} catch (e) {
		throw new Failure("bad_request", `path: ${(e as Error).message}`);
	}
}

const failure = (e: unknown) =>
	e instanceof NodeRunnerError
		? new Failure(
				e.code === "not_found" || e.code === "bad_request"
					? e.code
					: "conflict",
				e.message,
				{ reason: e.code },
			)
		: e;

type Op =
	Exclude<ArchiveRequest, { op: "host-dirs" }> extends infer R
		? R extends unknown
			? Omit<R, "target">
			: never
		: never;

/** Runs `req` in the service's replica `taskId` (or its first one); a task of another service is never reached. */
async function archive(c: Context<Env>, req: Op) {
	const { id } = c.req.param() as { id: string };
	const taskId = c.req.query("taskId");
	const task = await runningTask(c, id, taskId);
	if (!task)
		throw new Failure(
			"conflict",
			taskId
				? "that replica is not running"
				: "the service has no running replica; start it first",
			{ reason: "not_running" },
		);
	return {
		task,
		handle: c.var.deps.nodes.archive(
			task.nodeId,
			{ ...req, target: { kind: "task", taskId: task.id } },
			{ signal: c.req.raw.signal },
		),
	};
}

async function settle<T>(p: Promise<T>) {
	try {
		return await p;
	} catch (e) {
		throw failure(e);
	}
}

export const containerFiles = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/container-files",
			tags,
			security,
			summary: "Browse a running container's filesystem",
			description:
				"Needs the `exec` permission. Stats `path` in a running replica (`taskId`, else the first) with symlinks followed, and lists a directory's children, directories first. A listing stops at 1,000 entries or 15 seconds of walking (`truncated`). Read through the Docker archive API, so it works without a shell in the image.",
			middleware: [exec],
			request: { params: Params, query: Query },
			responses: { 200: json(Listing, "Path and children"), ...errors },
		}),
		async (c) => {
			const path = containerPath(c.req.valid("query").path);
			const { task, handle } = await archive(c, { op: "stat", path });
			const result = await settle(handle.result);
			return c.json({ ...result, taskId: task.id }, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/container-files/content",
			tags,
			security,
			summary: "Read a text file from a running container",
			description:
				"Needs the `exec` permission. The first 1 MB of a regular file as UTF-8; `binary` (and no content) when that part holds a NUL byte.",
			middleware: [exec],
			request: { params: Params, query: Query },
			responses: { 200: json(FileContent, "Content"), ...errors },
		}),
		async (c) => {
			const { task, handle } = await archive(c, {
				op: "read",
				path: containerPath(c.req.valid("query").path),
				limitBytes: VIEW_LIMIT_BYTES,
			});
			const parts: Uint8Array[] = [];
			const result = await settle(
				(async () => {
					for await (const chunk of handle) parts.push(chunk);
					return handle.result;
				})(),
			);
			const data = Buffer.concat(parts);
			const binary = data.includes(0);
			return c.json(
				{
					taskId: task.id,
					path: result.path,
					size: result.entry.size,
					truncated: result.truncated,
					binary,
					content: binary ? null : new TextDecoder().decode(data),
				},
				200,
			);
		},
	)
	.openapi(
		// Audited like a write: pulling files out of a container is as sensitive as exec.
		mutation(
			"service.container_file_download",
			createRoute({
				method: "get",
				path: "/services/{id}/container-files/download",
				tags,
				security,
				summary: "Download a file from a running container",
				description:
					"Needs the `exec` permission. Streams a regular file up to 50 MB as an attachment. Audited.",
				middleware: [exec],
				request: { params: Params, query: Query },
				responses: { 200: { description: "The file bytes" }, ...errors },
			}),
		),
		async (c) => {
			const path = containerPath(c.req.valid("query").path);
			c.set("auditDiff", { path });
			const stat = await settle(
				(await archive(c, { op: "stat", path })).handle.result,
			);
			if (stat.entry.type !== "file")
				throw new Failure("bad_request", `${stat.path} is not a regular file`);
			if (stat.entry.size > MAX_ARCHIVE_READ_BYTES)
				throw new Failure(
					"bad_request",
					"files over 50 MB cannot be downloaded here; copy them out with the terminal",
				);
			const { handle } = await archive(c, {
				op: "read",
				path: stat.path,
				limitBytes: MAX_ARCHIVE_READ_BYTES,
			});
			// Fails before any byte is sent when the file vanished in between.
			const first = await settle(handle.next());
			const body = new ReadableStream<Uint8Array>({
				start(ctl) {
					if (!first.done) ctl.enqueue(first.value);
				},
				async pull(ctl) {
					try {
						const n = await handle.next();
						if (n.done) ctl.close();
						else ctl.enqueue(n.value);
					} catch (e) {
						ctl.error(e);
					}
				},
				cancel: () => void handle.return?.(),
			});
			const name = stat.path.split("/").at(-1) || "download";
			return new Response(body, {
				headers: {
					"content-type": "application/octet-stream",
					"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
					"x-content-type-options": "nosniff",
					"content-security-policy": "sandbox",
					"cache-control": "private, no-store",
				},
			});
		},
	)
	.openapi(
		mutation(
			"service.container_file_upload",
			createRoute({
				method: "put",
				path: "/services/{id}/container-files/upload",
				tags,
				security,
				summary: "Write one file into a running container",
				description:
					"Needs the `exec` permission. The raw body (up to 50 MB) becomes the file at `path`, whose directory must exist; an existing file is replaced, a directory never is. Written by the Docker daemon as root, into the container's writable layer or whatever volume is mounted there. Audited.",
				middleware: [exec],
				request: { params: Params, query: Query },
				responses: {
					201: json(z.object({ path: z.string() }), "Written"),
					...errors,
				},
			}),
		),
		async (c) => {
			const path = containerPath(c.req.valid("query").path);
			const slash = path.lastIndexOf("/");
			const dir = path.slice(0, slash) || "/";
			let name: string;
			try {
				name = safeRelativePath(path.slice(slash + 1));
			} catch {
				throw new Failure("bad_request", "path: name the file to write");
			}
			if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD_BYTES)
				throw new Failure("bad_request", "files are limited to 50 MB");
			const data = new Uint8Array(await c.req.arrayBuffer());
			if (data.length > MAX_UPLOAD_BYTES)
				throw new Failure("bad_request", "files are limited to 50 MB");
			c.set("auditDiff", { path, bytes: data.length });
			const { task, handle } = await archive(c, { op: "write", path: dir });
			c.set("auditDiff", { path, bytes: data.length, taskId: task.id });
			await settle(
				(async () => {
					await handle.write(buildTar([{ path: name, data }]));
					await handle.end();
					return handle.result;
				})(),
			);
			return c.json({ path }, 201);
		},
	);
