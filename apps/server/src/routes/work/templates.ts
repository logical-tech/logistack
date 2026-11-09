import { z } from "@hono/zod-openapi";
import {
	type TaskTemplate,
	type TemplateAssigneeRef,
	type TemplatePayload,
	type WorkFieldConfig,
	WorkTemplate,
	WorkTemplateCreate,
	WorkTemplateInstantiate,
	WorkTemplateInstantiateResult,
	WorkTemplateListItem,
	WorkTemplatePatch,
	type WorkViewConfig,
} from "@logistack/contracts";
import {
	instantiateTemplate,
	parseFieldValue,
	rankN,
	roleAllows,
	workingDaysBetween,
} from "@logistack/core";
import {
	type Db,
	member,
	project,
	user,
	workAttachment,
	workBlob,
	workChecklistItem,
	workDependency,
	workField,
	workFieldValue,
	workList,
	workProject,
	workStatus,
	workTag,
	workTask,
	workTaskAssignee,
	workTaskTag,
	workTemplate,
	workView,
} from "@logistack/db";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { type Actor, requireActor } from "../../actor.ts";
import type { Env } from "../../env.ts";
import { Failure, notFound } from "../../errors.ts";
import { body, errors, IdParam, json, router } from "../../openapi.ts";
import { actorCan, check, organizationResource } from "../../scope.ts";
import { ensureBuiltinTemplates } from "../../work/builtin-templates.ts";
import {
	checkWork,
	ensureWorkProject,
	nextTaskNumber,
	publishWork,
	workResource,
	writeActivity,
} from "../../work/context.ts";
import { mutationSpec, spec } from "./extras-a-spec.ts";

type Row = typeof workTemplate.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const readsWorkSomewhere = (actor: Actor) =>
	actor.grants.some(
		(g) => g.subjectId === actor.id && roleAllows(g.role, "read:work"),
	);

const countTasks = (ts: readonly TaskTemplate[]): number =>
	ts.reduce((n, t) => n + 1 + countTasks(t.subtasks), 0);
const taskCount = (p: TemplatePayload) =>
	countTasks(p.tasks ?? []) +
	(p.lists ?? []).reduce((n, l) => n + countTasks(l.tasks), 0);

const listItem = (r: Row): WorkTemplateListItem => ({
	id: r.id,
	organizationId: r.organizationId,
	projectId: r.projectId,
	kind: r.kind,
	name: r.name,
	description: r.description,
	createdBy: r.createdBy,
	usageCount: r.usageCount,
	builtin: r.organizationId === null,
	createdAt: r.createdAt.toISOString(),
	updatedAt: r.updatedAt.toISOString(),
	taskCount: taskCount(r.payload),
});
const full = (r: Row): WorkTemplate => {
	const { taskCount: _, ...rest } = listItem(r);
	return { ...rest, payload: r.payload };
};

/** A template the actor may see: built-ins, their organization's org-wide ones, project ones with `read:work`. */
async function visible(c: Context<Env>, id: string): Promise<Row> {
	const actor = requireActor(c);
	const { db } = c.var.deps;
	await ensureBuiltinTemplates(db);
	const [row] = await db
		.select()
		.from(workTemplate)
		.where(
			and(
				eq(workTemplate.id, id),
				or(
					isNull(workTemplate.organizationId),
					eq(workTemplate.organizationId, actor.organizationId),
				),
			),
		);
	if (!row) throw notFound("template");
	if (row.projectId) await checkWork(c, "read:work", row.projectId);
	else if (!readsWorkSomewhere(actor))
		throw new Failure("forbidden", "missing permission 'read:work'");
	return row;
}

/** Built-ins are read-only; project templates need `work:admin` there, org-wide ones at the organization. */
async function writable(c: Context<Env>, id: string): Promise<Row> {
	const row = await visible(c, id);
	if (!row.organizationId)
		throw new Failure(
			"forbidden",
			"built-in templates are read-only; duplicate one to change it",
		);
	if (row.projectId) await checkWork(c, "work:admin", row.projectId);
	else
		check(
			c,
			"work:admin",
			organizationResource(requireActor(c).organizationId),
		);
	return row;
}

// ---------------------------------------------------------------------------
// Save as template
// ---------------------------------------------------------------------------

type Include = WorkTemplateCreate["include"];

/** Builds a `TemplatePayload` from a task, a list or a whole project; dates become working-day offsets. */
async function buildPayload(
	db: Db,
	projectId: string,
	source: WorkTemplateCreate["source"],
	include: Include,
): Promise<TemplatePayload> {
	const [wp] = await db
		.select({ workingDays: workProject.workingDays })
		.from(workProject)
		.where(eq(workProject.projectId, projectId));
	const wd = wp?.workingDays ?? 31;
	const lists =
		source.kind === "task"
			? []
			: await db
					.select()
					.from(workList)
					.where(
						source.kind === "list"
							? eq(workList.id, source.listId)
							: and(
									eq(workList.projectId, projectId),
									isNull(workList.archivedAt),
								),
					)
					.orderBy(asc(workList.position));
	const tops = await db
		.select()
		.from(workTask)
		.where(
			and(
				source.kind === "task"
					? eq(workTask.id, source.taskId)
					: and(
							inArray(
								workTask.listId,
								lists.length ? lists.map((l) => l.id) : [""],
							),
							isNull(workTask.parentId),
						),
				isNull(workTask.archivedAt),
			),
		)
		.orderBy(asc(workTask.position));
	const subs =
		include.subtasks && tops.length
			? await db
					.select()
					.from(workTask)
					.where(
						and(
							inArray(
								workTask.parentId,
								tops.map((t) => t.id),
							),
							isNull(workTask.archivedAt),
						),
					)
					.orderBy(asc(workTask.position))
			: [];
	const all = [...tops, ...subs];
	const ids = all.length ? all.map((t) => t.id) : [""];
	const [
		statuses,
		tags,
		taskTags,
		fields,
		values,
		assignees,
		checklist,
		files,
		deps,
	] = await Promise.all([
		db
			.select()
			.from(workStatus)
			.where(eq(workStatus.projectId, projectId))
			.orderBy(asc(workStatus.position)),
		db.select().from(workTag).where(eq(workTag.projectId, projectId)),
		db.select().from(workTaskTag).where(inArray(workTaskTag.taskId, ids)),
		db
			.select()
			.from(workField)
			.where(eq(workField.projectId, projectId))
			.orderBy(asc(workField.position)),
		include.fieldValues
			? db
					.select()
					.from(workFieldValue)
					.where(inArray(workFieldValue.taskId, ids))
			: [],
		include.assignees === "none"
			? []
			: db
					.select({
						taskId: workTaskAssignee.taskId,
						userId: workTaskAssignee.userId,
						name: user.name,
					})
					.from(workTaskAssignee)
					.innerJoin(user, eq(user.id, workTaskAssignee.userId))
					.where(inArray(workTaskAssignee.taskId, ids)),
		include.checklist
			? db
					.select()
					.from(workChecklistItem)
					.where(inArray(workChecklistItem.taskId, ids))
					.orderBy(asc(workChecklistItem.position))
			: [],
		include.attachments
			? db
					.select({ taskId: workAttachment.taskId, sha: workAttachment.sha256 })
					.from(workAttachment)
					.where(
						and(
							inArray(workAttachment.taskId, ids),
							isNull(workAttachment.deletedAt),
							isNull(workAttachment.commentId),
						),
					)
			: [],
		db.select().from(workDependency).where(inArray(workDependency.taskId, ids)),
	]);
	const statusName = new Map(statuses.map((s) => [s.id, s.name]));
	const tagName = new Map(tags.map((t) => [t.id, t.name]));
	const fieldName = new Map(fields.map((f) => [f.id, f.name]));
	const dated = all
		.map((t) => t.startDate ?? t.dueDate)
		.filter((d): d is string => !!d)
		.sort();
	const anchor = dated[0];
	const offset = (d: string | null) =>
		d && anchor ? workingDaysBetween(anchor, d, wd) : undefined;
	const assigneeRef = (userId: string, name: string): TemplateAssigneeRef =>
		include.assignees === "fixed" ? { userId } : { placeholder: name };
	const usedTags = new Set<string>();
	const usedFields = new Set<string>();

	const toTemplate = (
		t: (typeof all)[number],
		siblings: (typeof all)[number][],
	): TaskTemplate => {
		const myTags = taskTags
			.filter((x) => x.taskId === t.id)
			.map((x) => x.tagId);
		for (const id of myTags) usedTags.add(id);
		const myValues = values.filter((v) => v.taskId === t.id);
		for (const v of myValues) usedFields.add(v.fieldId);
		return {
			title: t.title,
			description: include.descriptions ? t.description : null,
			priority: t.priority,
			startOffset: offset(t.startDate),
			dueOffset: offset(t.dueDate),
			isMilestone: t.isMilestone,
			estimateMinutes: t.estimateMinutes,
			statusRef: statusName.get(t.statusId) ?? null,
			tagRefs: myTags.map((id) => tagName.get(id) ?? "").filter(Boolean),
			fieldValues: myValues.map((v) => ({
				fieldRef: fieldName.get(v.fieldId) ?? v.fieldId,
				value: v.value,
			})),
			assigneeRefs: assignees
				.filter((a) => a.taskId === t.id)
				.map((a) => assigneeRef(a.userId, a.name)),
			checklist: checklist
				.filter((i) => i.taskId === t.id)
				.map((i) => {
					const who = i.assigneeId
						? assignees.find((a) => a.userId === i.assigneeId)
						: undefined;
					return {
						text: i.text,
						...(who && include.assignees !== "none"
							? { assigneeRef: assigneeRef(who.userId, who.name) }
							: {}),
					};
				}),
			subtasks: (() => {
				const mine = subs.filter((s) => s.parentId === t.id);
				return mine.map((s) => toTemplate(s, mine));
			})(),
			attachmentShas: files.filter((f) => f.taskId === t.id).map((f) => f.sha),
			dependsOn: deps
				.filter((d) => d.taskId === t.id)
				.map((d) => siblings.findIndex((s) => s.id === d.blockedById))
				.filter((i) => i >= 0),
		};
	};

	const payload: TemplatePayload = {};
	if (source.kind === "task")
		payload.tasks = tops.map((t) => toTemplate(t, tops));
	else
		payload.lists = lists.map((l) => {
			const mine = tops.filter((t) => t.listId === l.id);
			return {
				name: l.name,
				color: l.color,
				icon: l.icon,
				tasks: mine.map((t) => toTemplate(t, mine)),
			};
		});
	const fieldDef = (f: (typeof fields)[number]) => ({
		ref: f.name,
		name: f.name,
		config: f.config,
		required: f.required,
		description: f.description,
	});
	if (source.kind === "project") {
		payload.statuses = statuses.map((s) => ({
			ref: s.name,
			name: s.name,
			color: s.color,
			category: s.category,
			wipLimit: s.wipLimit,
		}));
		payload.fields = fields.map(fieldDef);
		payload.tags = tags.map((t) => ({
			ref: t.name,
			name: t.name,
			color: t.color,
		}));
		payload.views = (
			await db
				.select()
				.from(workView)
				.where(and(eq(workView.projectId, projectId), isNull(workView.ownerId)))
				.orderBy(asc(workView.position))
		).map((v) => ({ name: v.name, kind: v.kind, config: v.config }));
	} else {
		payload.fields = fields.filter((f) => usedFields.has(f.id)).map(fieldDef);
		payload.tags = tags
			.filter((t) => usedTags.has(t.id))
			.map((t) => ({ ref: t.name, name: t.name, color: t.color }));
	}
	return payload;
}

/** The project a template source lives in (404 outside the actor's organization). */
async function sourceProject(
	db: Db,
	organizationId: string,
	source: WorkTemplateCreate["source"],
): Promise<string> {
	if (source.kind === "project") return source.projectId;
	const [row] =
		source.kind === "task"
			? await db
					.select({ projectId: workTask.projectId })
					.from(workTask)
					.innerJoin(project, eq(project.id, workTask.projectId))
					.where(
						and(
							eq(workTask.id, source.taskId),
							eq(project.organizationId, organizationId),
						),
					)
			: await db
					.select({ projectId: workList.projectId })
					.from(workList)
					.innerJoin(project, eq(project.id, workList.projectId))
					.where(
						and(
							eq(workList.id, source.listId),
							eq(project.organizationId, organizationId),
						),
					);
	if (!row) throw notFound(source.kind);
	return row.projectId;
}

// ---------------------------------------------------------------------------
// Instantiate
// ---------------------------------------------------------------------------

class DryRun extends Error {
	constructor(readonly result: WorkTemplateInstantiateResult) {
		super("dry run");
	}
}

const lower = (s: string) => s.toLowerCase();

async function instantiate(
	tx: Tx,
	o: {
		tpl: Row;
		input: z.infer<typeof WorkTemplateInstantiate>;
		projectId: string;
		listId: string | null;
		actorId: string;
		organizationId: string;
		admin: boolean;
	},
): Promise<WorkTemplateInstantiateResult> {
	const { tpl, input, projectId, actorId } = o;
	const p = tpl.payload;
	const warnings: string[] = [];
	const created = { tasks: 0, lists: 0, fields: 0, statuses: 0 };
	const [wp] = await tx
		.select()
		.from(workProject)
		.where(eq(workProject.projectId, projectId));
	if (!wp) throw notFound("project");
	const toProject = o.listId === null;

	// Statuses: by name; a project template applied to a project adds the ones missing.
	const statuses = await tx
		.select()
		.from(workStatus)
		.where(eq(workStatus.projectId, projectId))
		.orderBy(asc(workStatus.position));
	if (toProject && p.statuses?.length) {
		const missing = p.statuses.filter(
			(s) => !statuses.some((x) => lower(x.name) === lower(s.name)),
		);
		const ranks = rankN(
			statuses.at(-1)?.position ?? null,
			null,
			missing.length,
		);
		if (missing.length)
			statuses.push(
				...(await tx
					.insert(workStatus)
					.values(
						missing.map((s, i) => ({
							projectId,
							name: s.name,
							color: s.color,
							category: s.category,
							wipLimit: s.wipLimit ?? null,
							position: ranks[i] as string,
						})),
					)
					.returning()),
			);
		created.statuses = missing.length;
	}
	const statusRefName = new Map(
		(p.statuses ?? []).map((s) => [s.ref, s.name] as const),
	);
	const firstActive =
		statuses.find((s) => s.category === "active") ?? statuses[0];
	if (!firstActive)
		throw new Failure("conflict", "the project has no statuses");
	const statusFor = (ref: string | null) => {
		const name = ref ? (statusRefName.get(ref) ?? ref) : null;
		return (
			(name && statuses.find((s) => lower(s.name) === lower(name))) ||
			firstActive
		);
	};

	// Fields: by name; missing ones are created (work:admin) or dropped.
	const fields = await tx
		.select()
		.from(workField)
		.where(eq(workField.projectId, projectId))
		.orderBy(asc(workField.position));
	const fieldMap: Record<string, string> = {};
	const fieldDefs = new Map<string, { config: WorkFieldConfig }>();
	const createFields = input.missingFields === "create" && o.admin;
	for (const f of p.fields ?? []) {
		let row = fields.find((x) => lower(x.name) === lower(f.name));
		if (!row && createFields) {
			[row] = await tx
				.insert(workField)
				.values({
					projectId,
					name: f.name,
					kind: f.config.kind,
					config: f.config,
					required: f.required ?? false,
					description: f.description ?? null,
					position: rankN(
						fields.at(-1)?.position ?? null,
						null,
						1,
					)[0] as string,
				})
				.returning();
			if (row) {
				fields.push(row);
				created.fields++;
			}
		}
		if (row) {
			fieldMap[f.ref] = row.id;
			fieldDefs.set(row.id, row);
		}
	}

	// Tags: by name; missing ones need work:admin.
	const tags = await tx
		.select()
		.from(workTag)
		.where(eq(workTag.projectId, projectId));
	const tagRefName = new Map((p.tags ?? []).map((t) => [t.ref, t] as const));
	const tagFor = async (ref: string) => {
		const def = tagRefName.get(ref);
		const name = def?.name ?? ref;
		let row = tags.find((t) => lower(t.name) === lower(name));
		if (!row && o.admin) {
			[row] = await tx
				.insert(workTag)
				.values({ projectId, name, color: def?.color ?? "gray" })
				.returning();
			if (row) tags.push(row);
		}
		if (!row)
			warnings.push(`Tag "${name}" isn't in the target project: dropped`);
		return row?.id;
	};

	if (toProject && p.views?.length) {
		const views = await tx
			.select()
			.from(workView)
			.where(and(eq(workView.projectId, projectId), isNull(workView.ownerId)))
			.orderBy(asc(workView.position));
		const missing = p.views.filter(
			(v) => !views.some((x) => lower(x.name) === lower(v.name)),
		);
		const ranks = rankN(views.at(-1)?.position ?? null, null, missing.length);
		if (missing.length)
			await tx.insert(workView).values(
				missing.map((v, i) => ({
					projectId,
					name: v.name,
					kind: v.kind,
					config: v.config as WorkViewConfig,
					position: ranks[i] as string,
				})),
			);
	}

	// Lists: into the target list, or new lists for a project target.
	const listIds: (string | null)[] = [];
	const defaultList = o.listId ?? wp.defaultListId;
	if (!defaultList) throw new Failure("conflict", "the project has no list");
	if (toProject && p.lists?.length) {
		const existing = await tx
			.select()
			.from(workList)
			.where(eq(workList.projectId, projectId))
			.orderBy(asc(workList.position));
		const taken = new Set(
			existing.filter((l) => !l.archivedAt).map((l) => lower(l.name)),
		);
		const ranks = rankN(
			existing.at(-1)?.position ?? null,
			null,
			p.lists.length,
		);
		for (const [i, l] of p.lists.entries()) {
			let name = l.name;
			for (let n = 2; taken.has(lower(name)); n++) name = `${l.name} ${n}`;
			taken.add(lower(name));
			const [row] = await tx
				.insert(workList)
				.values({
					projectId,
					name,
					color: l.color ?? null,
					icon: l.icon ?? null,
					position: ranks[i] as string,
				})
				.returning({ id: workList.id });
			listIds.push(row?.id ?? null);
			created.lists++;
		}
	}

	const drafts = instantiateTemplate(
		p,
		{
			date: input.anchor.date,
			mode: input.anchor.mode,
			creatorId: actorId,
			workingDays: wp.workingDays,
		},
		fieldMap,
		input.placeholders,
	);
	warnings.push(...drafts.warnings);

	const members = new Set(
		(
			await tx
				.select({ userId: member.userId })
				.from(member)
				.where(eq(member.organizationId, o.organizationId))
		).map((m) => m.userId),
	);
	const listOf = (i: number | null) =>
		(i === null ? undefined : listIds[i]) ?? defaultList;
	// Appended after each list's last task.
	const nextRank = new Map<string, string | null>();
	const rankIn = async (listId: string) => {
		if (!nextRank.has(listId)) {
			const [r] = await tx
				.select({ p: sql<string | null>`max(${workTask.position})` })
				.from(workTask)
				.where(eq(workTask.listId, listId));
			nextRank.set(listId, r?.p ?? null);
		}
		const pos = rankN(nextRank.get(listId), null, 1)[0] as string;
		nextRank.set(listId, pos);
		return pos;
	};
	const ids = new Map<string, string>();
	for (const d of drafts.tasks) {
		const listId = listOf(d.listIndex);
		const [row] = await tx
			.insert(workTask)
			.values({
				projectId,
				listId,
				parentId: d.parentRef ? (ids.get(d.parentRef) ?? null) : null,
				number: await nextTaskNumber(tx, projectId),
				title: d.title,
				description: d.description,
				priority: d.priority,
				startDate: d.startDate,
				dueDate: d.dueDate,
				isMilestone: d.isMilestone,
				estimateMinutes: d.estimateMinutes,
				statusId: statusFor(d.statusRef).id,
				position: await rankIn(listId),
				source: { kind: "template", externalId: tpl.id },
				createdBy: actorId,
			})
			.returning({ id: workTask.id });
		if (!row) continue;
		ids.set(d.ref, row.id);
		created.tasks++;
		const people = d.assigneeIds.filter((u) => members.has(u));
		if (people.length < d.assigneeIds.length)
			warnings.push(
				`"${d.title}": someone who left the organization was not assigned`,
			);
		if (people.length)
			await tx.insert(workTaskAssignee).values(
				people.map((userId) => ({
					taskId: row.id,
					userId,
					assignedBy: actorId,
				})),
			);
		for (const ref of d.tagRefs) {
			const tagId = await tagFor(ref);
			if (tagId)
				await tx
					.insert(workTaskTag)
					.values({ taskId: row.id, tagId })
					.onConflictDoNothing();
		}
		for (const [fieldId, raw] of Object.entries(d.fields)) {
			const def = fieldDefs.get(fieldId);
			const parsed = def ? parseFieldValue(def, raw) : null;
			if (parsed?.ok && parsed.value !== null)
				await tx.insert(workFieldValue).values({
					taskId: row.id,
					fieldId,
					value: parsed.value,
					updatedBy: actorId,
				});
			else
				warnings.push(
					`"${d.title}": a field value didn't fit the target field: dropped`,
				);
		}
		if (d.checklist.length) {
			const ranks = rankN(null, null, d.checklist.length);
			await tx.insert(workChecklistItem).values(
				d.checklist.map((c, i) => ({
					taskId: row.id,
					text: c.text,
					assigneeId:
						c.assigneeId && members.has(c.assigneeId) ? c.assigneeId : null,
					position: ranks[i] as string,
				})),
			);
		}
		for (const sha of d.attachmentShas) {
			const [src] = await tx
				.select({ a: workAttachment })
				.from(workAttachment)
				.innerJoin(project, eq(project.id, workAttachment.projectId))
				.where(
					and(
						eq(workAttachment.sha256, sha),
						eq(project.organizationId, o.organizationId),
						isNull(workAttachment.deletedAt),
					),
				)
				.limit(1);
			if (!src) {
				warnings.push(`"${d.title}": an attachment no longer exists: skipped`);
				continue;
			}
			const { id: _, createdAt: __, updatedAt: ___, ...copy } = src.a;
			await tx.insert(workAttachment).values({
				...copy,
				projectId,
				taskId: row.id,
				commentId: null,
				inlineIn: "none",
				uploaderId: actorId,
			});
			if (copy.driver === "db")
				await tx
					.update(workBlob)
					.set({ refCount: sql`${workBlob.refCount} + 1` })
					.where(eq(workBlob.sha256, sha));
		}
		await writeActivity(tx, {
			taskId: row.id,
			actorId,
			kind: "created",
			data: { template: tpl.name },
		});
	}
	for (const d of drafts.tasks) {
		const taskId = ids.get(d.ref);
		const deps = d.dependsOn
			.map((r) => ids.get(r))
			.filter((x): x is string => !!x && x !== taskId);
		if (taskId && deps.length)
			await tx
				.insert(workDependency)
				.values(
					deps.map((blockedById) => ({
						taskId,
						blockedById,
						createdBy: actorId,
					})),
				)
				.onConflictDoNothing();
	}
	if (
		!o.admin &&
		input.missingFields === "create" &&
		(p.fields?.length ?? 0) > created.fields
	)
		warnings.push(
			"Creating fields needs the Work admin permission: missing fields were dropped",
		);
	return {
		dryRun: !!input.dryRun,
		created,
		taskIds: [...ids.values()],
		warnings: [...new Set(warnings)],
	};
}

export const workTemplates = router()
	.openapi(
		spec("templateList", {
			summary: "Templates: built-in, organization-wide and the project's",
			request: { query: z.object({ projectId: z.string().optional() }) },
			responses: {
				200: json(z.array(WorkTemplateListItem), "Templates"),
				...errors,
			},
		}),
		async (c) => {
			const { projectId } = c.req.valid("query");
			const actor = requireActor(c);
			const { db } = c.var.deps;
			if (projectId) await checkWork(c, "read:work", projectId);
			else if (!readsWorkSomewhere(actor))
				throw new Failure("forbidden", "missing permission 'read:work'");
			await ensureBuiltinTemplates(db);
			const rows = await db
				.select()
				.from(workTemplate)
				.where(
					or(
						isNull(workTemplate.organizationId),
						and(
							eq(workTemplate.organizationId, actor.organizationId),
							projectId
								? or(
										isNull(workTemplate.projectId),
										eq(workTemplate.projectId, projectId),
									)
								: isNull(workTemplate.projectId),
						),
					),
				)
				.orderBy(asc(workTemplate.name));
			return c.json(rows.map(listItem), 200);
		},
	)
	.openapi(
		spec("templateGet", {
			summary: "A template with its payload",
			request: { params: IdParam },
			responses: { 200: json(WorkTemplate, "Template"), ...errors },
		}),
		async (c) => c.json(full(await visible(c, c.req.valid("param").id)), 200),
	)
	.openapi(
		mutationSpec("work_template.create", "templateCreate", {
			summary: "Save a task, list or project as a template",
			request: body(WorkTemplateCreate),
			responses: { 201: json(WorkTemplate, "Created"), ...errors },
		}),
		async (c) => {
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const { db } = c.var.deps;
			if (input.projectId) await checkWork(c, "work:admin", input.projectId);
			else check(c, "work:admin", organizationResource(actor.organizationId));
			const from = await sourceProject(db, actor.organizationId, input.source);
			await checkWork(c, "read:work", from);
			const payload = await buildPayload(db, from, input.source, input.include);
			const [row] = await db
				.insert(workTemplate)
				.values({
					organizationId: actor.organizationId,
					projectId: input.projectId ?? null,
					kind: input.source.kind,
					name: input.name,
					description: input.description ?? null,
					payload,
					createdBy: actor.userId,
				})
				.returning();
			if (!row) throw new Error("template not saved");
			c.set("auditResourceId", row.id);
			return c.json(full(row), 201);
		},
	)
	.openapi(
		mutationSpec("work_template.update", "templateUpdate", {
			summary: "Rename a template or change its description",
			request: { params: IdParam, ...body(WorkTemplatePatch) },
			responses: { 200: json(WorkTemplate, "Updated"), ...errors },
		}),
		async (c) => {
			const tpl = await writable(c, c.req.valid("param").id);
			const [row] = await c.var.deps.db
				.update(workTemplate)
				.set({ ...c.req.valid("json"), updatedAt: new Date() })
				.where(eq(workTemplate.id, tpl.id))
				.returning();
			return c.json(full(row ?? tpl), 200);
		},
	)
	.openapi(
		mutationSpec("work_template.delete", "templateDelete", {
			summary: "Delete a template",
			request: { params: IdParam },
			responses: { 204: { description: "Deleted" }, ...errors },
		}),
		async (c) => {
			const tpl = await writable(c, c.req.valid("param").id);
			await c.var.deps.db
				.delete(workTemplate)
				.where(eq(workTemplate.id, tpl.id));
			return c.body(null, 204);
		},
	)
	.openapi(
		mutationSpec("work_template.instantiate", "templateInstantiate", {
			summary:
				"Create tasks (or a project's setup) from a template, in one transaction",
			request: { params: IdParam, ...body(WorkTemplateInstantiate) },
			responses: {
				200: json(
					WorkTemplateInstantiateResult,
					"Created (or the dry-run counts)",
				),
				...errors,
			},
		}),
		async (c) => {
			const tpl = await visible(c, c.req.valid("param").id);
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const { db } = c.var.deps;
			let projectId: string;
			let listId: string | null = null;
			if ("listId" in input.target) {
				const [l] = await db
					.select({
						projectId: workList.projectId,
						archivedAt: workList.archivedAt,
					})
					.from(workList)
					.innerJoin(project, eq(project.id, workList.projectId))
					.where(
						and(
							eq(workList.id, input.target.listId),
							eq(project.organizationId, actor.organizationId),
						),
					);
				if (!l || l.archivedAt) throw notFound("list");
				projectId = l.projectId;
				listId = input.target.listId;
				await checkWork(c, "work", projectId);
			} else {
				projectId = input.target.projectId;
				await checkWork(c, "work:admin", projectId);
			}
			const admin = actorCan(
				actor,
				"work:admin",
				await workResource(c, projectId),
			);
			await ensureWorkProject(db, projectId);
			c.set("auditResourceId", tpl.id);
			let result: WorkTemplateInstantiateResult;
			try {
				result = await db.transaction(async (tx) => {
					const r = await instantiate(tx, {
						tpl,
						input,
						projectId,
						listId,
						actorId: actor.userId,
						organizationId: actor.organizationId,
						admin,
					});
					if (input.dryRun) throw new DryRun({ ...r, taskIds: [] });
					await tx
						.update(workTemplate)
						.set({ usageCount: sql`${workTemplate.usageCount} + 1` })
						.where(eq(workTemplate.id, tpl.id));
					return r;
				});
			} catch (err) {
				if (err instanceof DryRun) return c.json(err.result, 200);
				throw err;
			}
			if (result.taskIds.length)
				publishWork(c.var.deps, {
					organizationId: actor.organizationId,
					projectId,
					entity: listId ? "task" : "project",
					op: "upsert",
					taskIds: result.taskIds,
					actorId: actor.userId,
				});
			return c.json(result, 200);
		},
	);
