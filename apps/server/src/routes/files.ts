/*
 * A service's files: its config mounts, edited in place and rolled out with a deployment, and the
 * contents of its named volumes, read and written through the running replica (an exec on the
 * node that runs it), so uploads land wherever the volume lives.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { decrypt, encrypt, type Resource } from "@logistack/core";
import { mount } from "@logistack/db";
import { buildTar, safeRelativePath } from "@logistack/docker";
import {
	ExecFailed,
	feed,
	NodeRunnerError,
	tail,
} from "@logistack/worker/node-runner";
import { and, asc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import {
	body,
	Deployment,
	errors,
	IdParam,
	json,
	router,
	security,
} from "../openapi.ts";
import { actorCan, byParam, check, requirePermission } from "../scope.ts";
import { actorTrigger, queueDeployment, runningTask } from "./service-ops.ts";

const tags = ["services"];

/** An absolute path inside the container, without `..`. */
export const MountTarget = z
	.string()
	.regex(/^\/[\w.@+-]+(\/[\w.@+-]+)*$/, "an absolute path like /etc/app.conf")
	.max(255)
	.refine((p) => !p.split("/").includes(".."), ".. is not allowed");

/** Swarm caps a config at 500 KB. */
export const ConfigContent = z
	.string()
	.max(500 * 1024)
	.refine((s) => s.trim().length > 0, "the file is empty");

/** Per uploaded file; the body is buffered to build the archive. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const LIST_LIMIT_BYTES = 2 * 1024 * 1024;

const ConfigFile = z
	.object({
		id: z.string(),
		target: z.string(),
		/** Null without `read:secrets`: config files often hold credentials. */
		content: z.string().nullable(),
		updatedAt: z.string(),
	})
	.openapi("ServiceConfigFile");

const Volume = z
	.object({ id: z.string(), target: z.string(), name: z.string() })
	.openapi("ServiceVolume");

const StaticFile = z
	.object({
		/** Relative to the volume root. */
		path: z.string(),
		size: z.int(),
		modifiedAt: z.string(),
	})
	.openapi("StaticFile");

const FileParams = z.object({ id: z.string(), mountId: z.string() });
const PathQuery = z.object({ path: z.string().min(1).max(1024) });

async function serviceMount(
	c: Context<Env>,
	serviceId: string,
	mountId: string,
	kind: "config" | "volume",
) {
	const [m] = await c.var.deps.db
		.select()
		.from(mount)
		.where(
			and(
				eq(mount.id, mountId),
				eq(mount.serviceId, serviceId),
				eq(mount.kind, kind),
			),
		);
	if (!m) throw notFound(kind === "config" ? "config file" : "volume");
	return m;
}

const nodeFailure = (e: unknown) =>
	e instanceof NodeRunnerError
		? new Failure("conflict", e.message, { reason: e.code })
		: e;

async function replica(c: Context<Env>, serviceId: string) {
	const task = await runningTask(c, serviceId);
	if (!task)
		throw new Failure(
			"conflict",
			"the service has no running replica; start it first",
			{ reason: "not_running" },
		);
	return task;
}

/** Runs `cmd` in the running replica and returns its stdout; a non-zero exit is a 409. */
async function inReplica(c: Context<Env>, serviceId: string, cmd: string[]) {
	const task = await replica(c, serviceId);
	const job = c.var.deps.nodes.runJob(task.nodeId, {
		kind: "exec",
		target: { kind: "task", taskId: task.id },
		cmd,
		timeoutSec: 30,
		outputLimitBytes: LIST_LIMIT_BYTES,
	});
	const out = new TextDecoder();
	const err = new TextDecoder();
	let stdout = "";
	let stderr = "";
	try {
		for await (const ch of job)
			if (ch.stream === "stdout")
				stdout += out.decode(ch.data, { stream: true });
			else stderr = tail(stderr + err.decode(ch.data, { stream: true }), 2000);
		const r = await job.result;
		if (r.exitCode !== 0)
			throw new Failure("conflict", `${cmd[0]} failed (exit ${r.exitCode})`, {
				reason: "tool_failed",
				stderr: stderr.trim(),
			});
		return { stdout, truncated: r.truncated };
	} catch (e) {
		throw nodeFailure(e);
	}
}

/** `stat -c '%s %Y %n'` lines into files relative to `root`; names with newlines are skipped. */
export function parseListing(stdout: string, root: string) {
	const files: z.infer<typeof StaticFile>[] = [];
	for (const line of stdout.split("\n")) {
		const m = /^(\d+) (\d+) (.+)$/.exec(line);
		if (!m?.[3]?.startsWith(`${root}/`)) continue;
		files.push({
			path: m[3].slice(root.length + 1),
			size: Number(m[1]),
			modifiedAt: new Date(Number(m[2]) * 1000).toISOString(),
		});
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

function relativePath(raw: string) {
	try {
		return safeRelativePath(raw);
	} catch (e) {
		throw new Failure("bad_request", `path: ${(e as Error).message}`);
	}
}

export const files = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/files",
			tags,
			security,
			summary: "Config files and named volumes of a service",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: {
				200: json(
					z.object({ files: z.array(ConfigFile), volumes: z.array(Volume) }),
					"Files",
				),
				...errors,
			},
		}),
		async (c) => {
			const { db, masterKey } = c.var.deps;
			const reveal = actorCan(
				requireActor(c),
				"read:secrets",
				c.get("resource") as Resource,
			);
			const rows = await db
				.select()
				.from(mount)
				.where(eq(mount.serviceId, c.req.valid("param").id))
				.orderBy(asc(mount.target));
			const files = await Promise.all(
				rows
					.filter((m) => m.kind === "config")
					.map(async (m) => ({
						id: m.id,
						target: m.target,
						content: reveal
							? await decrypt(masterKey, m.contentEncrypted ?? "")
							: null,
						updatedAt: m.updatedAt.toISOString(),
					})),
			);
			const volumes = rows
				.filter((m) => m.kind === "volume")
				.map((m) => ({
					id: m.id,
					target: m.target,
					name: m.volumeName ?? m.id,
				}));
			return c.json({ files, volumes }, 200);
		},
	)
	.openapi(
		mutation(
			"service.file_update",
			createRoute({
				method: "put",
				path: "/services/{id}/files/{mountId}",
				tags,
				security,
				summary: "Replace a config file and roll it out",
				description:
					"Stores the content encrypted and queues a deployment: the file becomes a new Swarm config and the replicas are replaced start-first. A config the server rejects fails the deployment and Swarm rolls back.",
				middleware: [requirePermission("write", byParam("service"))],
				request: {
					params: FileParams,
					...body(z.object({ content: ConfigContent })),
				},
				responses: {
					202: json(
						z.object({ deployment: Deployment }),
						"Saved and deployment queued",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id, mountId } = c.req.valid("param");
			check(c, "deploy", c.get("resource") as Resource);
			const m = await serviceMount(c, id, mountId, "config");
			const { content } = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			await db
				.update(mount)
				.set({
					contentEncrypted: await encrypt(masterKey, content),
					updatedAt: new Date(),
				})
				.where(eq(mount.id, m.id));
			const row = await queueDeployment(c, {
				serviceId: id,
				trigger: actorTrigger(requireActor(c)),
			});
			c.set("auditResourceId", id);
			c.set("auditDiff", { target: m.target, bytes: content.length });
			return c.json({ deployment: row }, 202);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/volumes/{mountId}/files",
			tags,
			security,
			summary: "Files in a named volume",
			description:
				"Every regular file under the volume, read with `find` and `stat` in the running replica. `truncated` when the listing passed 2 MB.",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: FileParams },
			responses: {
				200: json(
					z.object({ files: z.array(StaticFile), truncated: z.boolean() }),
					"Files",
				),
				...errors,
			},
		}),
		async (c) => {
			const { id, mountId } = c.req.valid("param");
			const root = (await serviceMount(c, id, mountId, "volume")).target;
			const { stdout, truncated } = await inReplica(c, id, [
				"find",
				root,
				"-type",
				"f",
				"-exec",
				"stat",
				"-c",
				"%s %Y %n",
				"{}",
				"+",
			]);
			return c.json({ files: parseListing(stdout, root), truncated }, 200);
		},
	)
	.openapi(
		mutation(
			"service.volume_upload",
			createRoute({
				method: "put",
				path: "/services/{id}/volumes/{mountId}/upload",
				tags,
				security,
				summary: "Write one file into a named volume",
				description:
					"The raw body (up to 50 MB) is wrapped in a tar under `path`, relative to the volume root, and extracted by `tar` in the running replica. Parent folders are created; an existing file is replaced.",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: FileParams, query: PathQuery },
				responses: {
					201: json(z.object({ path: z.string() }), "Written"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id, mountId } = c.req.valid("param");
			const path = relativePath(c.req.valid("query").path);
			if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD_BYTES)
				throw new Failure("bad_request", "files are limited to 50 MB");
			const root = (await serviceMount(c, id, mountId, "volume")).target;
			const data = new Uint8Array(await c.req.arrayBuffer());
			if (data.length > MAX_UPLOAD_BYTES)
				throw new Failure("bad_request", "files are limited to 50 MB");
			c.set("auditDiff", { volume: root, path, bytes: data.length });
			const task = await replica(c, id);
			const exec = c.var.deps.nodes.exec(
				task.nodeId,
				{
					target: { kind: "task", taskId: task.id },
					cmd: ["tar", "-x", "-C", root],
					stdin: true,
				},
				{ signal: c.req.raw.signal },
			);
			try {
				const tar = buildTar([{ path, data }]);
				await feed(
					exec,
					(async function* () {
						yield tar;
					})(),
				);
			} catch (e) {
				if (e instanceof ExecFailed)
					throw new Failure("conflict", `tar failed (exit ${e.code})`, {
						reason: "tool_failed",
						stderr: e.stderr,
					});
				throw nodeFailure(e);
			}
			return c.json({ path }, 201);
		},
	)
	.openapi(
		mutation(
			"service.volume_delete",
			createRoute({
				method: "delete",
				path: "/services/{id}/volumes/{mountId}/files",
				tags,
				security,
				summary: "Delete a file or folder from a named volume",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: FileParams, query: PathQuery },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id, mountId } = c.req.valid("param");
			const path = relativePath(c.req.valid("query").path);
			const root = (await serviceMount(c, id, mountId, "volume")).target;
			c.set("auditDiff", { volume: root, path });
			await inReplica(c, id, ["rm", "-rf", "--", `${root}/${path}`]);
			return c.body(null, 204);
		},
	);
