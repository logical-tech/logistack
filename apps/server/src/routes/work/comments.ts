import { z } from "@hono/zod-openapi";
import {
	type PmDoc,
	WORK_COMMENT_MAX_BYTES,
	WorkComment,
	WorkCommentCreate,
	WorkCommentPatch,
	WorkReaction,
} from "@logistack/contracts";
import { docToText, newMentions, sanitizeDoc } from "@logistack/core";
import {
	member,
	workAttachment,
	workComment,
	workReaction,
	workTaskWatcher,
} from "@logistack/db";
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Context } from "hono";
import { mutation } from "../../audit.ts";
import type { Env } from "../../env.ts";
import { Failure, notFound } from "../../errors.ts";
import { body, errors, IdParam, json, router } from "../../openapi.ts";
import { actorCan } from "../../scope.ts";
import { toAttachmentDto } from "../../work/attachments.ts";
import { publishWork, workResource } from "../../work/context.ts";
import {
	memberAccess,
	type NotifyInput,
	notify,
	publishTaskEvent,
} from "../../work/notify.ts";
import {
	checkTask,
	type LoadedTask,
	loadTask,
	workRoute,
} from "./collab-shared.ts";

type Row = typeof workComment.$inferSelect;

/** Comments with their reactions and live attachments, in the order given. */
async function toDtos(c: Context<Env>, rows: Row[]): Promise<WorkComment[]> {
	if (rows.length === 0) return [];
	const { db } = c.var.deps;
	const ids = rows.map((r) => r.id);
	const reactions = await db
		.select()
		.from(workReaction)
		.where(inArray(workReaction.commentId, ids))
		.orderBy(asc(workReaction.createdAt));
	const files = await db
		.select()
		.from(workAttachment)
		.where(
			and(
				inArray(workAttachment.commentId, ids),
				isNull(workAttachment.deletedAt),
			),
		)
		.orderBy(asc(workAttachment.createdAt));
	return rows.map((r) => {
		const mine = reactions.filter((x) => x.commentId === r.id);
		const emojis = [...new Set(mine.map((x) => x.emoji))];
		return {
			id: r.id,
			taskId: r.taskId,
			authorId: r.authorId,
			parentId: r.parentId,
			body: r.body,
			bodyText: r.bodyText,
			editedAt: r.editedAt?.toISOString() ?? null,
			deletedAt: r.deletedAt?.toISOString() ?? null,
			resolvedAt: r.resolvedAt?.toISOString() ?? null,
			resolvedBy: r.resolvedBy,
			createdAt: r.createdAt.toISOString(),
			reactions: emojis
				.filter((e) => WorkReaction.safeParse(e).success)
				.map((e) => ({
					emoji: e as WorkReaction,
					userIds: mine.filter((x) => x.emoji === e).map((x) => x.userId),
				})),
			attachments: files
				.filter((f) => f.commentId === r.id)
				.map(toAttachmentDto),
		};
	});
}

function clean(doc: PmDoc) {
	try {
		return sanitizeDoc(doc, WORK_COMMENT_MAX_BYTES);
	} catch (error) {
		throw new Failure("bad_request", (error as Error).message);
	}
}

/** The comment, its task and the actor's permission for `action` on the task's project. */
async function loadComment(c: Context<Env>, id: string) {
	const [row] = await c.var.deps.db
		.select()
		.from(workComment)
		.where(eq(workComment.id, id));
	if (!row) throw notFound("comment");
	return { row, task: await loadTask(c, row.taskId) };
}

/** Watches the task unless the user already watches (or muted it). */
async function watch(
	c: Context<Env>,
	taskId: string,
	userIds: string[],
	reason: "comment" | "mention",
) {
	if (userIds.length === 0) return;
	await c.var.deps.db
		.insert(workTaskWatcher)
		.values(userIds.map((userId) => ({ taskId, userId, reason })))
		.onConflictDoNothing();
}

/** Mentioned users who are members and may read the task; others are silently ignored. */
async function readersAmong(c: Context<Env>, task: LoadedTask, ids: string[]) {
	if (ids.length === 0) return [];
	const members = await c.var.deps.db
		.select({ userId: member.userId })
		.from(member)
		.where(
			and(
				eq(member.organizationId, task.organizationId),
				inArray(member.userId, ids),
			),
		);
	const resource = await workResource(c, task.projectId);
	const access = memberAccess(c.var.deps, task.organizationId);
	const out: string[] = [];
	for (const m of members)
		if (await access(m.userId, "read:work", resource)) out.push(m.userId);
	return out;
}

function mentionNotes(
	task: LoadedTask,
	actorId: string,
	commentId: string,
	users: string[],
): NotifyInput[] {
	return users.map((userId) => ({
		userId,
		kind: "mentioned",
		taskId: task.id,
		projectId: task.projectId,
		organizationId: task.organizationId,
		actorId,
		commentId,
	}));
}

const EmojiParam = IdParam.extend({ emoji: z.string() });

export const workComments = router()
	.openapi(
		workRoute("commentList", {
			summary: "Comments of a task",
			request: { params: IdParam },
			responses: { 200: json(z.array(WorkComment), "Comments"), ...errors },
		}),
		async (c) => {
			const task = await loadTask(c, c.req.valid("param").id);
			await checkTask(c, "read:work", task);
			const rows = await c.var.deps.db
				.select()
				.from(workComment)
				.where(eq(workComment.taskId, task.id))
				.orderBy(asc(workComment.createdAt), asc(workComment.id));
			return c.json(await toDtos(c, rows), 200);
		},
	)
	.openapi(
		mutation(
			"work_comment.create",
			workRoute("commentCreate", {
				summary: "Comment on a task, or reply to a comment",
				description:
					"Replies are one level deep: replying to a reply joins its thread. Mentioned members are notified and start watching; the author watches too.",
				request: { params: IdParam, ...body(WorkCommentCreate) },
				responses: { 201: json(WorkComment, "Comment"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const task = await loadTask(c, c.req.valid("param").id);
			const { actor } = await checkTask(c, "comment:work", task);
			const { db } = c.var.deps;
			const doc = clean(input.body);
			let parent: Row | undefined;
			if (input.parentId) {
				[parent] = await db
					.select()
					.from(workComment)
					.where(
						and(
							eq(workComment.id, input.parentId),
							eq(workComment.taskId, task.id),
						),
					);
				if (!parent) throw notFound("parent comment");
			}
			const rootId = parent ? (parent.parentId ?? parent.id) : null;
			const row = await db.transaction(async (tx) => {
				const [created] = await tx
					.insert(workComment)
					.values({
						taskId: task.id,
						authorId: actor.userId,
						parentId: rootId,
						body: doc,
						bodyText: docToText(doc),
					})
					.returning();
				if (!created) throw new Error("comment not inserted");
				if (input.attachmentIds?.length) {
					const bound = await tx
						.update(workAttachment)
						.set({ commentId: created.id, inlineIn: "comment" })
						.where(
							and(
								inArray(workAttachment.id, input.attachmentIds),
								eq(workAttachment.taskId, task.id),
								eq(workAttachment.uploaderId, actor.userId),
								isNull(workAttachment.commentId),
								isNull(workAttachment.deletedAt),
							),
						)
						.returning({ id: workAttachment.id });
					if (bound.length !== new Set(input.attachmentIds).size)
						throw new Failure(
							"bad_request",
							"attachmentIds must be your own uploads on this task, not yet in a comment",
						);
				}
				return created;
			});
			c.set("auditResourceId", row.id);
			const mentioned = await readersAmong(
				c,
				task,
				newMentions(null, doc).filter((id) => id !== actor.userId),
			);
			await watch(c, task.id, [actor.userId], "comment");
			await watch(c, task.id, mentioned, "mention");
			const notes = mentionNotes(task, actor.userId, row.id, mentioned);
			if (rootId) {
				const thread = await db
					.select({ authorId: workComment.authorId })
					.from(workComment)
					.where(
						or(eq(workComment.id, rootId), eq(workComment.parentId, rootId)),
					);
				for (const t of thread)
					if (t.authorId)
						notes.push({
							userId: t.authorId,
							kind: "replied",
							taskId: task.id,
							projectId: task.projectId,
							organizationId: task.organizationId,
							actorId: actor.userId,
							commentId: row.id,
						});
			}
			const watchers = await db
				.select({ userId: workTaskWatcher.userId })
				.from(workTaskWatcher)
				.where(
					and(
						eq(workTaskWatcher.taskId, task.id),
						eq(workTaskWatcher.muted, false),
						ne(workTaskWatcher.userId, actor.userId),
					),
				);
			for (const w of watchers)
				notes.push({
					userId: w.userId,
					kind: "commented",
					taskId: task.id,
					projectId: task.projectId,
					organizationId: task.organizationId,
					actorId: actor.userId,
					commentId: row.id,
				});
			await notify(c.var.deps, notes);
			publishWork(c.var.deps, {
				organizationId: task.organizationId,
				projectId: task.projectId,
				taskIds: [task.id],
				entity: "comment",
				op: "upsert",
				actorId: actor.userId,
			});
			await publishTaskEvent(c.var.deps, "task.commented", task, {
				actorId: actor.userId,
				commentId: row.id,
			});
			const [dto] = await toDtos(c, [row]);
			return c.json(dto as WorkComment, 201);
		},
	)
	.openapi(
		mutation(
			"work_comment.update",
			workRoute("commentUpdate", {
				summary: "Edit your comment",
				description: "Only newly mentioned members are notified.",
				request: { params: IdParam, ...body(WorkCommentPatch) },
				responses: { 200: json(WorkComment, "Comment"), ...errors },
			}),
		),
		async (c) => {
			const { row, task } = await loadComment(c, c.req.valid("param").id);
			const { actor } = await checkTask(c, "comment:work", task);
			if (row.authorId !== actor.userId)
				throw new Failure("forbidden", "only the author can edit a comment");
			if (row.deletedAt) throw new Failure("conflict", "comment deleted");
			const doc = clean(c.req.valid("json").body);
			const [updated] = await c.var.deps.db
				.update(workComment)
				.set({ body: doc, bodyText: docToText(doc), editedAt: new Date() })
				.where(eq(workComment.id, row.id))
				.returning();
			const mentioned = await readersAmong(
				c,
				task,
				newMentions(row.body, doc).filter((id) => id !== actor.userId),
			);
			await watch(c, task.id, mentioned, "mention");
			await notify(
				c.var.deps,
				mentionNotes(task, actor.userId, row.id, mentioned),
			);
			publishWork(c.var.deps, {
				organizationId: task.organizationId,
				projectId: task.projectId,
				taskIds: [task.id],
				entity: "comment",
				op: "upsert",
				actorId: actor.userId,
			});
			const [dto] = await toDtos(c, [updated as Row]);
			return c.json(dto as WorkComment, 200);
		},
	)
	.openapi(
		mutation(
			"work_comment.delete",
			workRoute("commentDelete", {
				summary: "Delete a comment",
				description:
					"Soft delete: the body goes, the row stays so the thread keeps its shape. The author or a work:admin may delete.",
				request: { params: IdParam },
				responses: { 200: json(WorkComment, "Deleted comment"), ...errors },
			}),
		),
		async (c) => {
			const { row, task } = await loadComment(c, c.req.valid("param").id);
			const { actor, resource } = await checkTask(c, "comment:work", task);
			if (
				row.authorId !== actor.userId &&
				!actorCan(actor, "work:admin", resource)
			)
				throw new Failure(
					"forbidden",
					"only the author or a work admin can delete a comment",
				);
			const now = new Date();
			const updated = await c.var.deps.db.transaction(async (tx) => {
				const [u] = await tx
					.update(workComment)
					.set({ body: null, bodyText: null, deletedAt: row.deletedAt ?? now })
					.where(eq(workComment.id, row.id))
					.returning();
				await tx
					.update(workAttachment)
					.set({ deletedAt: now })
					.where(
						and(
							eq(workAttachment.commentId, row.id),
							isNull(workAttachment.deletedAt),
						),
					);
				return u as Row;
			});
			publishWork(c.var.deps, {
				organizationId: task.organizationId,
				projectId: task.projectId,
				taskIds: [task.id],
				entity: "comment",
				op: "delete",
				actorId: actor.userId,
			});
			const [dto] = await toDtos(c, [updated]);
			return c.json(dto as WorkComment, 200);
		},
	)
	.openapi(
		mutation(
			"work_comment.resolve",
			workRoute("commentResolve", {
				summary: "Resolve a comment thread",
				request: { params: IdParam },
				responses: { 200: json(WorkComment, "Comment"), ...errors },
			}),
		),
		(c) => setResolved(c, true),
	)
	.openapi(
		mutation(
			"work_comment.unresolve",
			workRoute("commentUnresolve", {
				summary: "Reopen a resolved comment thread",
				request: { params: IdParam },
				responses: { 200: json(WorkComment, "Comment"), ...errors },
			}),
		),
		(c) => setResolved(c, false),
	)
	.openapi(
		mutation(
			"work_reaction.add",
			workRoute("reactionAdd", {
				summary: "React to a comment",
				description: "One of 8 fixed emoji.",
				request: { params: EmojiParam },
				responses: { 200: json(WorkComment, "Comment"), ...errors },
			}),
		),
		(c) => react(c, true),
	)
	.openapi(
		mutation(
			"work_reaction.remove",
			workRoute("reactionRemove", {
				summary: "Remove your reaction",
				request: { params: EmojiParam },
				responses: { 200: json(WorkComment, "Comment"), ...errors },
			}),
		),
		(c) => react(c, false),
	);

async function setResolved(c: Context<Env>, resolved: boolean) {
	const { row, task } = await loadComment(c, c.req.param("id") ?? "");
	const { actor } = await checkTask(c, "work", task);
	const [updated] = await c.var.deps.db
		.update(workComment)
		.set(
			resolved
				? {
						resolvedAt: row.resolvedAt ?? new Date(),
						resolvedBy: row.resolvedBy ?? actor.userId,
					}
				: { resolvedAt: null, resolvedBy: null },
		)
		.where(eq(workComment.id, row.id))
		.returning();
	publishWork(c.var.deps, {
		organizationId: task.organizationId,
		projectId: task.projectId,
		taskIds: [task.id],
		entity: "comment",
		op: "upsert",
		actorId: actor.userId,
	});
	const [dto] = await toDtos(c, [updated as Row]);
	return c.json(dto as WorkComment, 200);
}

async function react(c: Context<Env>, add: boolean) {
	const emoji = WorkReaction.safeParse(c.req.param("emoji"));
	if (!emoji.success)
		throw new Failure(
			"bad_request",
			"emoji must be one of the fixed reactions",
		);
	const { row, task } = await loadComment(c, c.req.param("id") ?? "");
	const { actor } = await checkTask(c, "comment:work", task);
	if (row.deletedAt) throw new Failure("conflict", "comment deleted");
	const { db } = c.var.deps;
	if (add)
		await db
			.insert(workReaction)
			.values({ commentId: row.id, userId: actor.userId, emoji: emoji.data })
			.onConflictDoNothing();
	else
		await db
			.delete(workReaction)
			.where(
				and(
					eq(workReaction.commentId, row.id),
					eq(workReaction.userId, actor.userId),
					eq(workReaction.emoji, emoji.data),
				),
			);
	publishWork(c.var.deps, {
		organizationId: task.organizationId,
		projectId: task.projectId,
		taskIds: [task.id],
		entity: "comment",
		op: "upsert",
		actorId: actor.userId,
	});
	const [dto] = await toDtos(c, [row]);
	return c.json(dto as WorkComment, 200);
}
