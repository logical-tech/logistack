import { createRoute, z } from "@hono/zod-openapi";
import {
	AiAgentConversation,
	AiAgentMessage,
	type AiAgentStatus,
} from "@logistack/contracts";
import { aiAgentConversation, aiAgentMessage } from "@logistack/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { requireActor } from "../actor.ts";
import {
	denyPending,
	messageView,
	publishAgent,
	runAgent,
} from "../ai/agent.ts";
import { mutation, redact } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, one } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { inOrganization, requirePermission } from "../scope.ts";

const tags = ["ai"];
const aiPermission = requirePermission("ai", inOrganization);
/**
 * Runs execute as the member with all of their grants, so only a signed-in member may start or
 * read them: an API key (above all one narrowed to scopes) would otherwise widen to the owner's
 * grants and read the owner's chats. A key can call the REST API directly instead.
 */
const ai: MiddlewareHandler<Env> = async (c, next) => {
	if (requireActor(c).kind !== "user")
		throw new Failure(
			"forbidden",
			"the Agent is available to signed-in members only",
		);
	return aiPermission(c, next);
};

const Model = z.string().trim().min(1).max(300);
const Text = z.string().trim().min(1).max(32_000);

const Detail = z
	.object({
		conversation: AiAgentConversation,
		messages: z.array(AiAgentMessage),
	})
	.openapi("AiAgentConversationDetail");

type ConvRow = typeof aiAgentConversation.$inferSelect;

const view = (r: ConvRow): AiAgentConversation => ({
	id: r.id,
	title: r.title,
	model: r.model,
	status: r.status as AiAgentStatus,
	error: r.error,
	createdAt: r.createdAt.toISOString(),
	updatedAt: r.updatedAt.toISOString(),
});

/** The caller's own conversation; nobody reads another member's chats, admins included. */
async function mine(c: Context<Env>, id: string) {
	const actor = requireActor(c);
	c.set("auditResourceId", id);
	return one(
		await c.var.deps.db
			.select()
			.from(aiAgentConversation)
			.where(
				and(
					eq(aiAgentConversation.id, id),
					eq(aiAgentConversation.organizationId, actor.organizationId),
					eq(aiAgentConversation.userId, actor.userId),
				),
			),
		"conversation",
	);
}

/** Marks the conversation running and starts its run in the background. */
async function start(c: Context<Env>, id: string, model?: string) {
	const { deps } = c.var;
	const [row] = await deps.db
		.update(aiAgentConversation)
		.set({
			status: "running",
			error: null,
			stopRequested: false,
			...(model && { model }),
		})
		.where(eq(aiAgentConversation.id, id))
		.returning();
	await publishAgent(deps.config.REDIS_URL, id, "running");
	void runAgent(deps, id);
	return row as ConvRow;
}

const title = (text: string) => {
	const line = text.split("\n")[0]?.trim() ?? "";
	return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New chat";
};

export const aiAgent = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/ai/agent/conversations",
			tags,
			security,
			summary: "Your Agent conversations, newest first",
			middleware: [ai],
			responses: {
				200: json(z.array(AiAgentConversation), "Conversations"),
				...errors,
			},
		}),
		async (c) => {
			const actor = requireActor(c);
			const rows = await c.var.deps.db
				.select()
				.from(aiAgentConversation)
				.where(
					and(
						eq(aiAgentConversation.organizationId, actor.organizationId),
						eq(aiAgentConversation.userId, actor.userId),
					),
				)
				.orderBy(desc(aiAgentConversation.updatedAt))
				.limit(200);
			return c.json(rows.map(view), 200);
		},
	)
	.openapi(
		mutation(
			"ai_agent_conversation.create",
			createRoute({
				method: "post",
				path: "/ai/agent/conversations",
				tags,
				security,
				summary: "Start a conversation with the Agent",
				description:
					"Saves the message and starts the run on the server. It keeps going with the page closed; follow it on the `ai-agent:<id>` /ws channel.",
				middleware: [ai],
				request: body(z.object({ text: Text, model: Model.default("auto") })),
				responses: { 201: json(AiAgentConversation, "Started"), ...errors },
			}),
		),
		async (c) => {
			const { text, model } = c.req.valid("json");
			const actor = requireActor(c);
			const { db } = c.var.deps;
			const conv = one(
				await db
					.insert(aiAgentConversation)
					.values({
						organizationId: actor.organizationId,
						userId: actor.userId,
						title: title(text),
						model,
					})
					.returning(),
			);
			c.set("auditResourceId", conv.id);
			await db.insert(aiAgentMessage).values({
				conversationId: conv.id,
				role: "user",
				parts: [{ type: "text", text }],
			});
			return c.json(view(await start(c, conv.id)), 201);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/ai/agent/conversations/{id}",
			tags,
			security,
			summary: "A conversation with every message",
			middleware: [ai],
			request: { params: IdParam },
			responses: { 200: json(Detail, "Conversation"), ...errors },
		}),
		async (c) => {
			const conv = await mine(c, c.req.valid("param").id);
			const rows = await c.var.deps.db
				.select()
				.from(aiAgentMessage)
				.where(eq(aiAgentMessage.conversationId, conv.id))
				.orderBy(asc(aiAgentMessage.createdAt));
			return c.json(
				{ conversation: view(conv), messages: rows.map(messageView) },
				200,
			);
		},
	)
	.openapi(
		mutation(
			"ai_agent_conversation.message",
			createRoute({
				method: "post",
				path: "/ai/agent/conversations/{id}/messages",
				tags,
				security,
				summary: "Send a message to the Agent",
				description:
					"Operations still waiting for approval are denied: the reply replaces the answer.",
				middleware: [ai],
				request: {
					params: IdParam,
					...body(z.object({ text: Text, model: Model.optional() })),
				},
				responses: { 202: json(AiAgentConversation, "Running"), ...errors },
			}),
		),
		async (c) => {
			const conv = await mine(c, c.req.valid("param").id);
			const { text, model } = c.req.valid("json");
			if (conv.status === "running")
				throw new Failure(
					"conflict",
					"The Agent is still answering. Stop it or wait.",
				);
			const { db } = c.var.deps;
			await denyPending(db, conv.id, "The user sent a new message instead.");
			await db.insert(aiAgentMessage).values({
				conversationId: conv.id,
				role: "user",
				parts: [{ type: "text", text }],
			});
			return c.json(view(await start(c, conv.id, model)), 202);
		},
	)
	.openapi(
		mutation(
			"ai_agent_conversation.approve",
			createRoute({
				method: "post",
				path: "/ai/agent/conversations/{id}/approvals",
				tags,
				security,
				summary: "Approve or deny an operation the Agent wants to run",
				middleware: [ai],
				request: {
					params: IdParam,
					...body(
						z.object({
							toolCallId: z.string().min(1),
							approved: z.boolean(),
							reason: z.string().trim().max(500).optional(),
						}),
					),
				},
				responses: { 202: json(AiAgentConversation, "Answered"), ...errors },
			}),
		),
		async (c) => {
			const conv = await mine(c, c.req.valid("param").id);
			const { toolCallId, approved, reason } = c.req.valid("json");
			const { db } = c.var.deps;
			const rows = await db
				.select()
				.from(aiAgentMessage)
				.where(eq(aiAgentMessage.conversationId, conv.id))
				.orderBy(desc(aiAgentMessage.createdAt))
				.limit(1);
			const msg = rows[0];
			const part = msg?.parts.find(
				(p) => p.type === "dynamic-tool" && p.toolCallId === toolCallId,
			);
			if (
				!msg ||
				part?.type !== "dynamic-tool" ||
				part.state !== "approval-requested" ||
				part.approval?.approved !== undefined
			)
				throw new Failure(
					"conflict",
					"This operation is not waiting for approval.",
				);
			const parts = msg.parts.map((p) =>
				p === part
					? { ...part, approval: { id: toolCallId, approved, reason } }
					: p,
			);
			await db
				.update(aiAgentMessage)
				.set({ parts })
				.where(eq(aiAgentMessage.id, msg.id));
			// Tool inputs can carry secret values (secret_update, env_var_create): redacted like any diff.
			c.set("auditDiff", { toolCallId, approved, input: redact(part.input) });
			// Other calls of the same answer may still wait; the run starts once all are answered.
			const open = parts.some(
				(p) =>
					p.type === "dynamic-tool" &&
					p.state === "approval-requested" &&
					p.approval?.approved === undefined,
			);
			if (open) {
				await publishAgent(c.var.deps.config.REDIS_URL, conv.id, "waiting", {
					...msg,
					parts,
				});
				return c.json(view(conv), 202);
			}
			return c.json(view(await start(c, conv.id)), 202);
		},
	)
	.openapi(
		mutation(
			"ai_agent_conversation.stop",
			createRoute({
				method: "post",
				path: "/ai/agent/conversations/{id}/stop",
				tags,
				security,
				summary: "Stop the Agent",
				middleware: [ai],
				request: { params: IdParam },
				responses: { 204: { description: "Stopping" }, ...errors },
			}),
		),
		async (c) => {
			const conv = await mine(c, c.req.valid("param").id);
			const { db, config } = c.var.deps;
			if (conv.status === "running") {
				await db
					.update(aiAgentConversation)
					.set({ stopRequested: true })
					.where(eq(aiAgentConversation.id, conv.id));
				return c.body(null, 204);
			}
			if (conv.status === "waiting") {
				await denyPending(db, conv.id, "Stopped by the user.");
				await db
					.update(aiAgentConversation)
					.set({ status: "idle" })
					.where(eq(aiAgentConversation.id, conv.id));
				await publishAgent(config.REDIS_URL, conv.id, "idle");
			}
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"ai_agent_conversation.update",
			createRoute({
				method: "patch",
				path: "/ai/agent/conversations/{id}",
				tags,
				security,
				summary: "Rename a conversation or change its model",
				middleware: [ai],
				request: {
					params: IdParam,
					...body(
						z.object({
							title: z.string().trim().min(1).max(100).optional(),
							model: Model.optional(),
						}),
					),
				},
				responses: { 200: json(AiAgentConversation, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const conv = await mine(c, c.req.valid("param").id);
			const input = c.req.valid("json");
			const [row] = await c.var.deps.db
				.update(aiAgentConversation)
				.set(input)
				.where(eq(aiAgentConversation.id, conv.id))
				.returning();
			return c.json(view(row ?? conv), 200);
		},
	)
	.openapi(
		mutation(
			"ai_agent_conversation.delete",
			createRoute({
				method: "delete",
				path: "/ai/agent/conversations/{id}",
				tags,
				security,
				summary: "Delete a conversation; a running Agent stops",
				middleware: [ai],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const conv = await mine(c, c.req.valid("param").id);
			await c.var.deps.db
				.delete(aiAgentConversation)
				.where(eq(aiAgentConversation.id, conv.id));
			return c.body(null, 204);
		},
	);
