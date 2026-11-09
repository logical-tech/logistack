import {
	type ErrorCode,
	WorkAiDescription,
	WorkAiSubtasks,
	WorkAiSummary,
} from "@logistack/contracts";
import {
	descriptionPrompt,
	markdownToDoc,
	parseSubtasks,
	stripFence,
	subtasksPrompt,
	summarisePrompt,
	type WorkAiMessage,
} from "@logistack/core";
import {
	project,
	user,
	workComment,
	workList,
	workProject,
	workTask,
} from "@logistack/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { requireActor } from "../../actor.ts";
import { asMember, gateway } from "../../ai/gateway.ts";
import type { Deps, Env } from "../../env.ts";
import { Failure, notFound } from "../../errors.ts";
import { errors, IdParam, json, router } from "../../openapi.ts";
import { checkWork } from "../../work/context.ts";
import { mutationSpec } from "./extras-a-spec.ts";

/** The gateway mounted on its own, for in-process calls that never leave the api. */
const gateways = new WeakMap<Deps, Hono<Env>>();
function inProcessGateway(deps: Deps) {
	let app = gateways.get(deps);
	if (!app) {
		app = new Hono<Env>()
			.use(async (c, next) => {
				c.set("deps", deps);
				await next();
			})
			.route("/v1", gateway);
		gateways.set(deps, app);
	}
	return app;
}

const gatewayCodes: Record<number, ErrorCode> = {
	400: "bad_request",
	401: "forbidden",
	403: "forbidden",
	404: "bad_request",
	429: "rate_limited",
};

/**
 * One chat completion through the in-process AI gateway as the actor: the org's budget, the `ai`
 * permission and the usage ledger apply as for any gateway call; the model is the org's `auto` chain.
 */
async function complete(c: Context<Env>, messages: WorkAiMessage[]) {
	const actor = requireActor(c);
	const { deps } = c.var;
	let res: Response;
	try {
		const req = await asMember(
			deps.db,
			actor.organizationId,
			actor.userId,
			new Request("http://logistack.internal/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "auto",
					stream: false,
					max_tokens: 1200,
					messages,
				}),
			}),
		);
		res = await inProcessGateway(deps).request(req);
	} catch (err) {
		const status = (err as { status?: number }).status;
		if (status)
			throw new Failure(
				gatewayCodes[status] ?? "unprocessable",
				(err as Error).message,
			);
		throw err;
	}
	const body = (await res.json().catch(() => undefined)) as
		| {
				choices?: { message?: { content?: string | null } }[];
				error?: { message?: string };
		  }
		| undefined;
	if (!res.ok)
		throw new Failure(
			gatewayCodes[res.status] ?? "unprocessable",
			body?.error?.message ?? `The AI gateway answered ${res.status}.`,
		);
	const text = body?.choices?.[0]?.message?.content?.trim();
	if (!text)
		throw new Failure("unprocessable", "The model sent an empty answer.");
	return text;
}

/** The task in the actor's organization; checks `ai` plus the route's Work action. */
async function taskFor(
	c: Context<Env>,
	id: string,
	action: "read:work" | "work",
) {
	const [t] = await c.var.deps.db
		.select({
			id: workTask.id,
			projectId: workTask.projectId,
			title: workTask.title,
			descriptionText: workTask.descriptionText,
			listName: workList.name,
			projectName: project.name,
		})
		.from(workTask)
		.innerJoin(workList, eq(workList.id, workTask.listId))
		.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
		.innerJoin(project, eq(project.id, workTask.projectId))
		.where(
			and(
				eq(workTask.id, id),
				eq(workProject.organizationId, requireActor(c).organizationId),
			),
		);
	if (!t) throw notFound("task");
	await checkWork(c, action, t.projectId);
	await checkWork(c, "ai", t.projectId);
	c.set("auditResourceId", t.id);
	return t;
}

// Audited (they spend the org's AI budget); nothing is written to the task: drafts go back to the sheet.
export const workAi = router()
	.openapi(
		mutationSpec("work_ai.summarise", "aiSummarise", {
			summary: "Summarise a task's comment thread into a draft comment",
			request: { params: IdParam },
			responses: { 200: json(WorkAiSummary, "Draft"), ...errors },
		}),
		async (c) => {
			const t = await taskFor(c, c.req.valid("param").id, "read:work");
			const comments = await c.var.deps.db
				.select({ text: workComment.bodyText, author: user.name })
				.from(workComment)
				.leftJoin(user, eq(user.id, workComment.authorId))
				.where(and(eq(workComment.taskId, t.id), isNull(workComment.deletedAt)))
				.orderBy(asc(workComment.createdAt))
				.limit(200);
			const thread = comments
				.filter((x) => x.text?.trim())
				.map((x) => ({
					author: x.author ?? "Former member",
					text: x.text ?? "",
				}));
			if (!thread.length)
				throw new Failure(
					"bad_request",
					"There are no comments to summarise yet.",
				);
			const text = await complete(
				c,
				summarisePrompt({ title: t.title, comments: thread }),
			);
			return c.json({ draft: markdownToDoc(stripFence(text)) }, 200);
		},
	)
	.openapi(
		mutationSpec("work_ai.subtasks", "aiSubtasks", {
			summary: "Propose subtasks with estimates (nothing is created)",
			request: { params: IdParam },
			responses: { 200: json(WorkAiSubtasks, "Proposed subtasks"), ...errors },
		}),
		async (c) => {
			const t = await taskFor(c, c.req.valid("param").id, "work");
			const text = await complete(
				c,
				subtasksPrompt({
					title: t.title,
					description: t.descriptionText ?? "",
				}),
			);
			const subtasks = parseSubtasks(text);
			if (!subtasks.length)
				throw new Failure(
					"unprocessable",
					"The model's answer had no subtasks. Try again.",
				);
			return c.json({ subtasks }, 200);
		},
	)
	.openapi(
		mutationSpec("work_ai.description", "aiDescription", {
			summary: "Draft a task description (nothing is saved)",
			request: { params: IdParam },
			responses: { 200: json(WorkAiDescription, "Draft"), ...errors },
		}),
		async (c) => {
			const t = await taskFor(c, c.req.valid("param").id, "work");
			const text = await complete(
				c,
				descriptionPrompt({
					title: t.title,
					project: t.projectName,
					list: t.listName,
				}),
			);
			return c.json({ description: markdownToDoc(stripFence(text)) }, 200);
		},
	);
