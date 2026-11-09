import { z } from "@hono/zod-openapi";
import {
	WorkAttachment,
	WorkAttachmentInline,
	WorkAttachmentSettings,
	WorkAttachmentSettingsUpdate,
	WorkBlobMigrationStarted,
} from "@logistack/contracts";
import {
	project,
	workAttachment,
	workComment,
	workOrgSettings,
} from "@logistack/db";
import { and, count, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../../actor.ts";
import { mutation } from "../../audit.ts";
import type { Env } from "../../env.ts";
import { Failure, notFound } from "../../errors.ts";
import { body, errors, IdParam, json, router } from "../../openapi.ts";
import { runQueues } from "../../run-queues.ts";
import { actorCan, check, organizationResource } from "../../scope.ts";
import {
	assertQuota,
	capUpload,
	cleanName,
	isRaster,
	maxUploadBytes,
	processImage,
	quotaOf,
	servedInline,
	sha256Hex,
	sniffContentType,
	toAttachmentDto,
	tooLarge,
} from "../../work/attachments.ts";
import {
	openAttachmentDestination,
	storeFor,
	writeStore,
} from "../../work/blob-store.ts";
import { checkWork, publishWork, writeActivity } from "../../work/context.ts";
import { checkTask, loadTask, workRoute } from "./collab-shared.ts";

export const ATTACHMENTS_PER_TASK = 100;

const CSP =
	"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

const UploadForm = z.object({
	file: z.any().openapi({ type: "string", format: "binary" }),
	taskId: z.string().optional(),
	commentId: z.string().optional(),
	inline: WorkAttachmentInline.optional(),
});

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` over `size`; null when absent or unsatisfiable. */
export function parseRange(header: string | undefined, size: number) {
	const m = header?.match(/^bytes=(\d*)-(\d*)$/);
	if (!m || (m[1] === "" && m[2] === "")) return null;
	let start: number;
	let end: number;
	if (m[1] === "") {
		start = Math.max(0, size - Number(m[2]));
		end = size - 1;
	} else {
		start = Number(m[1]);
		end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
	}
	return start <= end && start < size ? { start, end } : null;
}

async function loadAttachment(c: Context<Env>, id: string) {
	const [a] = await c.var.deps.db
		.select({ row: workAttachment, organizationId: project.organizationId })
		.from(workAttachment)
		.innerJoin(project, eq(project.id, workAttachment.projectId))
		.where(eq(workAttachment.id, id));
	if (
		!a ||
		a.row.deletedAt ||
		a.organizationId !== requireActor(c).organizationId
	)
		throw notFound("attachment");
	return a;
}

async function settingsOf(c: Context<Env>, organizationId: string) {
	const { db } = c.var.deps;
	const q = await quotaOf(c.var.deps, organizationId);
	const drivers = await db
		.select({ driver: workAttachment.driver, n: count() })
		.from(workAttachment)
		.innerJoin(project, eq(project.id, workAttachment.projectId))
		.where(
			and(
				eq(project.organizationId, organizationId),
				isNull(workAttachment.deletedAt),
			),
		)
		.groupBy(workAttachment.driver);
	return {
		...q,
		maxMb: Math.round((await maxUploadBytes(c.var.deps)) / 1024 / 1024),
		counts: {
			db: drivers.find((d) => d.driver === "db")?.n ?? 0,
			s3: drivers.find((d) => d.driver === "s3")?.n ?? 0,
		},
	};
}

const orgAdmin = (c: Context<Env>) => {
	const actor = requireActor(c);
	check(c, "work:admin", organizationResource(actor.organizationId));
	return actor;
};

export const workAttachments = router()
	.openapi(
		mutation(
			"work_attachment.create",
			workRoute("attachmentUpload", {
				summary: "Upload an attachment",
				middleware: [capUpload],
				description:
					"Multipart with `file` and `taskId` or `commentId`. The type is sniffed from the bytes; images lose their EXIF metadata and get a thumbnail. Over the instance cap → 413; over the organization quota → 409.",
				request: {
					body: {
						content: { "multipart/form-data": { schema: UploadForm } },
						required: true,
					},
				},
				responses: {
					201: json(WorkAttachment, "Attachment"),
					413: json(z.any(), "Too large"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { deps } = c.var;
			const cap = await maxUploadBytes(deps);
			const form = c.req.valid("form");
			const file = form.file;
			if (!(file instanceof File))
				throw new Failure("bad_request", "file is required");
			if (file.size > cap) throw tooLarge(cap);
			const inline = { data: form.inline ?? "none" };
			const commentId = form.commentId || null;
			let taskId = form.taskId;
			if (commentId) {
				const [cm] = await deps.db
					.select({
						taskId: workComment.taskId,
						deletedAt: workComment.deletedAt,
					})
					.from(workComment)
					.where(eq(workComment.id, commentId));
				if (!cm || cm.deletedAt) throw notFound("comment");
				taskId = cm.taskId;
			}
			if (!taskId)
				throw new Failure("bad_request", "taskId or commentId is required");
			const task = await loadTask(c, taskId);
			const onComment = !!commentId || inline.data === "comment";
			const { actor } = await checkTask(
				c,
				onComment ? "comment:work" : "work",
				task,
			);
			const [n] = await deps.db
				.select({ n: count() })
				.from(workAttachment)
				.where(
					and(
						eq(workAttachment.taskId, task.id),
						isNull(workAttachment.deletedAt),
					),
				);
			if ((n?.n ?? 0) >= ATTACHMENTS_PER_TASK)
				throw new Failure(
					"conflict",
					`a task holds at most ${ATTACHMENTS_PER_TASK} attachments`,
				);
			const name = cleanName(file.name);
			const raw = new Uint8Array(await file.arrayBuffer());
			const contentType = sniffContentType(raw, name);
			const image = isRaster(contentType)
				? await processImage(raw, contentType)
				: { bytes: raw, width: null, height: null, thumb: null };
			await assertQuota(deps, task.organizationId, image.bytes.length);
			const sha = sha256Hex(image.bytes);
			const thumbSha = image.thumb ? sha256Hex(image.thumb) : null;
			const store = await writeStore(deps, deps.db, task.organizationId);
			const key = store.keyFor(sha);
			const thumbKey = thumbSha ? store.keyFor(thumbSha) : null;
			await store.put(key, image.bytes, contentType);
			if (thumbKey && image.thumb)
				await store.put(thumbKey, image.thumb, "image/webp");
			let row: typeof workAttachment.$inferSelect;
			try {
				row = await deps.db.transaction(async (tx) => {
					const [r] = await tx
						.insert(workAttachment)
						.values({
							projectId: task.projectId,
							taskId: task.id,
							commentId,
							inlineIn: commentId ? "comment" : inline.data,
							uploaderId: actor.userId,
							name,
							contentType,
							size: image.bytes.length,
							sha256: sha,
							driver: store.driver,
							objectKey: key,
							width: image.width,
							height: image.height,
							thumbKey,
						})
						.returning();
					if (!r) throw new Error("attachment not inserted");
					if (r.inlineIn === "none")
						await writeActivity(tx, {
							taskId: task.id,
							actorId: actor.userId,
							kind: "attachment_added",
							data: { attachmentId: r.id, name },
						});
					return r;
				});
			} catch (error) {
				await store.release(key);
				if (thumbKey) await store.release(thumbKey);
				throw error;
			}
			c.set("auditResourceId", row.id);
			publishWork(deps, {
				organizationId: task.organizationId,
				projectId: task.projectId,
				taskIds: [task.id],
				entity: commentId ? "comment" : "task",
				op: "upsert",
				actorId: actor.userId,
			});
			return c.json(toAttachmentDto(row), 201);
		},
	)
	.openapi(
		workRoute("attachmentGet", {
			summary: "Download an attachment",
			description:
				"Raster images, PDF, audio and video are served inline; everything else (SVG and HTML included) downloads. `?thumb=1` returns the WebP thumbnail.",
			request: {
				params: IdParam,
				query: z.object({ thumb: z.string().optional() }),
			},
			responses: {
				200: { description: "The file" },
				206: { description: "A byte range" },
				304: { description: "Not modified" },
				...errors,
			},
		}),
		async (c) => {
			const { row: a, organizationId } = await loadAttachment(
				c,
				c.req.valid("param").id,
			);
			await checkWork(c, "read:work", a.projectId);
			const thumb = c.req.valid("query").thumb === "1";
			if (thumb && !a.thumbKey) throw notFound("thumbnail");
			const key = thumb ? (a.thumbKey as string) : a.objectKey;
			const type = thumb ? "image/webp" : a.contentType;
			const etag = `"${thumb ? `${a.sha256}-t` : a.sha256}"`;
			const headers: Record<string, string> = {
				"content-type": type,
				"x-content-type-options": "nosniff",
				"content-security-policy": CSP,
				"cache-control": "private, max-age=3600",
				etag,
				"accept-ranges": "bytes",
				"content-disposition": `${
					thumb || servedInline(type) ? "inline" : "attachment"
				}; filename*=UTF-8''${encodeURIComponent(thumb ? `${a.name}.webp` : a.name)}`,
			};
			if (c.req.header("if-none-match") === etag)
				return c.body(null, 304, headers);
			const store = await storeFor(c.var.deps, organizationId, a.driver);
			const body = await store.read(key);
			if (body instanceof Uint8Array) {
				const range = thumb
					? null
					: parseRange(c.req.header("range"), body.length);
				if (c.req.header("range") && !range && !thumb)
					return c.body(null, 416, {
						...headers,
						"content-range": `bytes */${body.length}`,
					});
				if (range)
					return c.body(body.subarray(range.start, range.end + 1), 206, {
						...headers,
						"content-range": `bytes ${range.start}-${range.end}/${body.length}`,
					});
				return c.body(body, 200, headers);
			}
			// shortcut: S3 reads stream the whole object (no Range pass-through yet); add a ranged download to the provider when large videos need seeking.
			return c.body(
				body,
				200,
				thumb ? headers : { ...headers, "content-length": String(a.size) },
			);
		},
	)
	.openapi(
		mutation(
			"work_attachment.delete",
			workRoute("attachmentDelete", {
				summary: "Delete an attachment",
				description:
					"The uploader or a work:admin. Soft delete: the bytes are collected 30 days later.",
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { row: a } = await loadAttachment(c, c.req.valid("param").id);
			// Every attachment has a task (comment attachments carry theirs too).
			const task = await loadTask(c, a.taskId ?? "");
			const { actor, resource } = await checkTask(c, "comment:work", task);
			if (
				a.uploaderId !== actor.userId &&
				!actorCan(actor, "work:admin", resource)
			)
				throw new Failure(
					"forbidden",
					"only the uploader or a work admin can delete an attachment",
				);
			await c.var.deps.db.transaction(async (tx) => {
				await tx
					.update(workAttachment)
					.set({ deletedAt: new Date() })
					.where(eq(workAttachment.id, a.id));
				if (a.taskId && a.inlineIn === "none")
					await writeActivity(tx, {
						taskId: a.taskId,
						actorId: actor.userId,
						kind: "attachment_removed",
						data: { attachmentId: a.id, name: a.name },
					});
			});
			publishWork(c.var.deps, {
				organizationId: task.organizationId,
				projectId: task.projectId,
				taskIds: [task.id],
				entity: a.commentId ? "comment" : "task",
				op: "upsert",
				actorId: actor.userId,
			});
			return c.body(null, 204);
		},
	)
	.openapi(
		workRoute("attachmentSettingsGet", {
			summary: "Attachment storage of the organization",
			responses: {
				200: json(WorkAttachmentSettings, "Settings"),
				...errors,
			},
		}),
		async (c) => {
			const actor = orgAdmin(c);
			return c.json(await settingsOf(c, actor.organizationId), 200);
		},
	)
	.openapi(
		mutation(
			"work_settings.attachments",
			workRoute("attachmentSettingsUpdate", {
				summary: "Change attachment storage",
				description:
					"`destinationId` sends new attachments to an S3 destination; existing ones stay where they are until moved with the migrate endpoint.",
				request: body(WorkAttachmentSettingsUpdate),
				responses: {
					200: json(WorkAttachmentSettings, "Settings"),
					...errors,
				},
			}),
		),
		async (c) => {
			const actor = orgAdmin(c);
			const input = c.req.valid("json");
			const { deps } = c.var;
			if (input.destinationId)
				await openAttachmentDestination(
					deps,
					actor.organizationId,
					input.destinationId,
				);
			const set = {
				...(input.quotaGb !== undefined
					? { attachmentQuotaGb: input.quotaGb }
					: {}),
				...(input.destinationId !== undefined
					? { attachmentDestinationId: input.destinationId }
					: {}),
			};
			const before = await settingsOf(c, actor.organizationId);
			await deps.db
				.insert(workOrgSettings)
				.values({ organizationId: actor.organizationId, ...set })
				.onConflictDoUpdate({
					target: workOrgSettings.organizationId,
					set: { ...set, updatedAt: new Date() },
				});
			c.set("auditDiff", {
				before: {
					quotaGb: before.quotaGb,
					destinationId: before.destinationId,
				},
				after: input,
			});
			return c.json(await settingsOf(c, actor.organizationId), 200);
		},
	)
	.openapi(
		mutation(
			"work_settings.migrate_attachments",
			workRoute("attachmentMigrate", {
				summary: "Move database attachments to the S3 destination",
				description:
					"Queues a resumable job; each attachment moves on its own. Progress shows in the settings counts.",
				responses: {
					202: json(WorkBlobMigrationStarted, "Queued"),
					...errors,
				},
			}),
		),
		async (c) => {
			const actor = orgAdmin(c);
			const s = await quotaOf(c.var.deps, actor.organizationId);
			if (!s.destinationId)
				throw new Failure(
					"conflict",
					"choose an S3 destination for attachments first",
				);
			const jobId = `migrate-blobs-${actor.organizationId}`;
			await runQueues(c.var.deps.config.REDIS_URL).work.add(
				"migrate-blobs",
				{ name: "migrate-blobs", organizationId: actor.organizationId },
				{ jobId, removeOnComplete: true, removeOnFail: true, attempts: 3 },
			);
			return c.json({ jobId }, 202);
		},
	);
