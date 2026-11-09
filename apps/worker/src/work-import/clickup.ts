import type {
	ClickUpImportConfig,
	PmDoc,
	PmNode,
	WorkColor,
	WorkFieldConfig,
	WorkImportPlan,
	WorkStatusCategory,
} from "@logistack/contracts";
import {
	type ClickUpMaps,
	type ClickUpStatus,
	docToText,
	mapClickUpField,
	mapClickUpStatus,
	mapClickUpTask,
	rankBetween,
	rankN,
} from "@logistack/core";
import {
	invitation,
	member,
	user,
	workActivity,
	workChecklistItem,
	workComment,
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
	workTimeEntry,
} from "@logistack/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
	ClickUpApi,
	type CuComment,
	type CuCommentPart,
	type CuTask,
	type CuUser,
} from "./clickup-api.ts";
import {
	type DbOrTx,
	DEFAULT_ATTACHMENT_CAP,
	type ImportDeps,
	idMap,
	storeImportedAttachment,
	type Tracker,
} from "./store.ts";

/**
 * ClickUp import (plan 12.5). Order: statuses/fields/lists → tasks (parents first) → checklists →
 * dependencies → comments → attachments → time entries. Every entity goes through `work_import_map`,
 * so a rerun updates rows instead of duplicating them, and each task commits with its map entry.
 */

type Project = { projectId: string; organizationId: string };

type Ctx = {
	deps: ImportDeps;
	api: ClickUpApi;
	cfg: ClickUpImportConfig;
	organizationId: string;
	importerId: string | null;
	map: ReturnType<typeof idMap>;
	t: Tracker;
	tz: string;
	/** ClickUp user id → org user id. */
	users: Record<string, string>;
};

const lower = (s: string) => s.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Structure: statuses, fields, lists, tags
// ---------------------------------------------------------------------------

async function findOrCreateStatus(
	db: DbOrTx,
	projectId: string,
	s: { name: string; category: WorkStatusCategory; color: WorkColor },
): Promise<string> {
	const rows = await db
		.select({
			id: workStatus.id,
			name: workStatus.name,
			position: workStatus.position,
		})
		.from(workStatus)
		.where(eq(workStatus.projectId, projectId))
		.orderBy(desc(workStatus.position));
	const found = rows.find((r) => lower(r.name) === lower(s.name));
	if (found) return found.id;
	const [row] = await db
		.insert(workStatus)
		.values({
			projectId,
			name: s.name.slice(0, 60),
			category: s.category,
			color: s.color,
			position: rankBetween(rows[0]?.position ?? null, null),
		})
		.returning({ id: workStatus.id });
	if (!row) throw new Error("status insert failed");
	return row.id;
}

/** ClickUp status name (lowercase) → local status id in `projectId`, creating what's missing. */
async function projectStatuses(
	c: Ctx,
	projectId: string,
	cuStatuses: ClickUpStatus[],
) {
	const { db } = c.deps;
	const out: Record<string, string> = {};
	for (const s of cuStatuses) {
		const key = lower(s.status);
		if (out[key]) continue;
		const choice = c.cfg.statuses[key];
		let wanted: {
			name: string;
			category: WorkStatusCategory;
			color: WorkColor;
		};
		if (choice && "statusId" in choice) {
			const [chosen] = await db
				.select()
				.from(workStatus)
				.where(eq(workStatus.id, choice.statusId));
			if (chosen?.projectId === projectId) {
				out[key] = chosen.id;
				continue;
			}
			const auto = mapClickUpStatus(s);
			wanted = chosen
				? { name: chosen.name, category: chosen.category, color: chosen.color }
				: auto;
		} else if (choice && "create" in choice) wanted = choice.create;
		else wanted = mapClickUpStatus(s);
		out[key] = await findOrCreateStatus(db, projectId, wanted);
	}
	return out;
}

async function findOrCreateField(
	db: DbOrTx,
	projectId: string,
	name: string,
	config: WorkFieldConfig,
) {
	const rows = await db
		.select({
			id: workField.id,
			name: workField.name,
			listId: workField.listId,
			position: workField.position,
		})
		.from(workField)
		.where(eq(workField.projectId, projectId))
		.orderBy(desc(workField.position));
	const found = rows.find(
		(r) => r.listId === null && lower(r.name) === lower(name),
	);
	if (found) return { id: found.id, created: false };
	const [row] = await db
		.insert(workField)
		.values({
			projectId,
			name: name.slice(0, 100),
			kind: config.kind,
			config,
			position: rankBetween(rows[0]?.position ?? null, null),
		})
		.returning({ id: workField.id });
	if (!row) throw new Error("field insert failed");
	return { id: row.id, created: true };
}

/** ClickUp field id → the Work field values import into, per the wizard's choices. */
async function projectFields(c: Ctx, projectId: string, listIds: string[]) {
	const { db } = c.deps;
	const seen = new Set<string>();
	const write: Record<string, { fieldId: string; config: WorkFieldConfig }> =
		{};
	for (const listId of listIds) {
		for (const f of await c.api.fields(listId)) {
			if (seen.has(f.id)) continue;
			seen.add(f.id);
			const auto = mapClickUpField(f);
			const choice =
				c.cfg.fields[f.id] ??
				("skip" in auto
					? { mode: "skip" as const }
					: { mode: "import" as const, config: auto.config });
			if (choice.mode === "skip") {
				c.t.skip(
					"field",
					f.name,
					"skip" in auto ? auto.reason : "skipped in the wizard",
				);
				continue;
			}
			if (choice.mode === "map") {
				const [target] = await db
					.select()
					.from(workField)
					.where(eq(workField.id, choice.fieldId));
				if (target?.projectId === projectId) {
					write[f.id] = { fieldId: target.id, config: target.config };
					continue;
				}
				if (!target) {
					c.t.skip("field", f.name, "the field it maps onto no longer exists");
					continue;
				}
				const r = await findOrCreateField(
					db,
					projectId,
					target.name,
					target.config,
				);
				write[f.id] = { fieldId: r.id, config: target.config };
				continue;
			}
			const config: WorkFieldConfig =
				choice.mode === "text_snapshot" ? { kind: "long_text" } : choice.config;
			const r = await findOrCreateField(db, projectId, f.name, config);
			if (r.created) c.t.created("field");
			write[f.id] = { fieldId: r.id, config };
		}
	}
	return write;
}

async function upsertList(
	c: Ctx,
	projectId: string,
	cuList: { id: string; name: string },
) {
	const { db } = c.deps;
	const existing = await c.map.get(db, "list", cuList.id);
	if (existing) {
		const [row] = await db
			.update(workList)
			.set({ updatedAt: new Date() })
			.where(and(eq(workList.id, existing), eq(workList.projectId, projectId)))
			.returning({ id: workList.id });
		if (row) {
			c.t.updated("list");
			return row.id;
		}
	}
	const lists = await db
		.select({ name: workList.name, position: workList.position })
		.from(workList)
		.where(
			and(
				eq(workList.projectId, projectId),
				sql`${workList.archivedAt} is null`,
			),
		)
		.orderBy(desc(workList.position));
	const taken = new Set(lists.map((l) => lower(l.name)));
	let name = cuList.name.slice(0, 100) || "List";
	for (let n = 2; taken.has(lower(name)); n++)
		name = `${cuList.name.slice(0, 90)} (${n})`;
	const [row] = await db
		.insert(workList)
		.values({
			projectId,
			name,
			position: rankBetween(lists[0]?.position ?? null, null),
		})
		.returning({ id: workList.id });
	if (!row) throw new Error("list insert failed");
	await c.map.set(db, "list", cuList.id, row.id);
	c.t.created("list");
	return row.id;
}

async function tagId(db: DbOrTx, projectId: string, name: string) {
	await db
		.insert(workTag)
		.values({ projectId, name: name.slice(0, 60), color: "gray" })
		.onConflictDoNothing();
	const [row] = await db
		.select({ id: workTag.id })
		.from(workTag)
		.where(
			and(
				eq(workTag.projectId, projectId),
				sql`lower(${workTag.name}) = ${lower(name.slice(0, 60))}`,
			),
		);
	return row?.id;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const para = (text: string): PmNode => ({
	type: "paragraph",
	content: text ? [{ type: "text", text }] : [],
});

const who = (u: CuUser) =>
	[u.username, u.email ? `(${u.email})` : ""].filter(Boolean).join(" ") ||
	`ClickUp user ${u.id}`;

/** The top-level ancestor inside this import: Work has one subtask level. */
function topParent(t: CuTask, byId: Map<string, CuTask>): string | null {
	let p = t.parent ?? null;
	const seen = new Set<string>();
	while (p && byId.get(p)?.parent && !seen.has(p)) {
		seen.add(p);
		p = byId.get(p)?.parent ?? null;
	}
	return p;
}

async function nextNumber(db: DbOrTx, projectId: string) {
	const [row] = await db
		.update(workProject)
		.set({ nextNumber: sql`${workProject.nextNumber} + 1` })
		.where(eq(workProject.projectId, projectId))
		.returning({ n: sql<number>`${workProject.nextNumber} - 1` });
	if (!row) throw new Error(`work_project ${projectId} missing`);
	return Number(row.n);
}

async function importTask(
	c: Ctx,
	p: Project,
	listId: string,
	t: CuTask,
	parentLocal: string | null,
	maps: ClickUpMaps,
	position: () => string,
	related: string[],
): Promise<string> {
	const d = mapClickUpTask(t, maps);
	const extra: PmNode[] = [];
	const unmatched = (t.assignees ?? []).filter((a) => !c.users[String(a.id)]);
	if (unmatched.length)
		extra.push(
			para(`Originally assigned to ${unmatched.map(who).join(", ")}.`),
		);
	if (related.length)
		extra.push(para(`Related in ClickUp: ${related.join(", ")}.`));
	const description: PmDoc | null =
		d.description || extra.length
			? { type: "doc", content: [...(d.description?.content ?? []), ...extra] }
			: null;
	const creator = t.creator ? c.users[String(t.creator.id)] : undefined;
	const source = {
		kind: "clickup" as const,
		externalId: t.id,
		...(c.cfg.options.keepUrls && d.url ? { url: d.url } : {}),
	};
	const values = {
		title: d.title,
		statusId: d.statusId,
		priority: d.priority,
		startDate: d.startDate,
		dueDate: d.dueDate,
		dueTime: d.dueTime,
		estimateMinutes: d.estimateMinutes,
		description,
		descriptionText: description ? docToText(description) : null,
		source,
		archivedAt: d.archived ? new Date() : null,
	};
	return c.deps.db.transaction(async (tx) => {
		const known = await c.map.get(tx, "task", t.id);
		let id: string | undefined;
		if (known) {
			const [row] = await tx
				.update(workTask)
				.set({
					...values,
					listId,
					parentId: parentLocal,
					updatedAt: new Date(),
				})
				.where(and(eq(workTask.id, known), eq(workTask.projectId, p.projectId)))
				.returning({ id: workTask.id });
			id = row?.id;
			if (id) c.t.updated("task");
		}
		if (!id) {
			const [row] = await tx
				.insert(workTask)
				.values({
					...values,
					projectId: p.projectId,
					listId,
					parentId: parentLocal,
					number: await nextNumber(tx, p.projectId),
					position: position(),
					createdBy: creator ?? c.importerId,
				})
				.returning({ id: workTask.id });
			if (!row) throw new Error("task insert failed");
			id = row.id;
			await tx.insert(workActivity).values({
				taskId: id,
				actorId: c.importerId,
				kind: "imported",
				data: { source: "clickup", externalId: t.id },
			});
			await c.map.set(tx, "task", t.id, id);
			c.t.created("task");
		}
		const taskId = id;
		// Only what came from ClickUp is replaced: assignees and the imported fields.
		await tx
			.delete(workTaskAssignee)
			.where(eq(workTaskAssignee.taskId, taskId));
		if (d.assigneeIds.length)
			await tx
				.insert(workTaskAssignee)
				.values(
					[...new Set(d.assigneeIds)]
						.slice(0, 20)
						.map((userId) => ({ taskId, userId, assignedBy: c.importerId })),
				)
				.onConflictDoNothing();
		for (const name of d.tagNames) {
			const tag = await tagId(tx, p.projectId, name);
			if (tag)
				await tx
					.insert(workTaskTag)
					.values({ taskId, tagId: tag })
					.onConflictDoNothing();
		}
		for (const [fieldId, value] of Object.entries(d.fields))
			await tx
				.insert(workFieldValue)
				.values({ taskId, fieldId, value, updatedBy: c.importerId })
				.onConflictDoUpdate({
					target: [workFieldValue.taskId, workFieldValue.fieldId],
					set: { value, updatedAt: new Date() },
				});
		return taskId;
	});
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/** ClickUp's comment parts → ProseMirror: text with marks, links, mentions of matched people. */
export function commentToDoc(
	parts: CuCommentPart[] | undefined,
	text: string | undefined,
	users: Record<string, string>,
): PmDoc {
	const blocks: PmNode[] = [];
	let line: PmNode[] = [];
	const flush = () => {
		blocks.push({
			type: "paragraph",
			...(line.length ? { content: line } : {}),
		});
		line = [];
	};
	const source = parts?.length ? parts : [{ text: text ?? "" }];
	for (const part of source) {
		if (part.type === "tag" && part.user) {
			const id = users[String(part.user.id)];
			line.push(
				id
					? { type: "mention", attrs: { id, label: part.user.username ?? "" } }
					: { type: "text", text: `@${part.user.username ?? "someone"}` },
			);
			continue;
		}
		const a = part.attributes ?? {};
		const marks = [
			...(a.bold ? [{ type: "bold" }] : []),
			...(a.italic ? [{ type: "italic" }] : []),
			...(a.code ? [{ type: "code" }] : []),
			...(a.link && /^https?:/i.test(a.link)
				? [{ type: "link", attrs: { href: a.link } }]
				: []),
		];
		const pieces = (part.text ?? "").split("\n");
		pieces.forEach((piece, i) => {
			if (i > 0) flush();
			if (piece)
				line.push({
					type: "text",
					text: piece,
					...(marks.length ? { marks } : {}),
				});
		});
	}
	if (line.length) flush();
	while (blocks.length && !blocks.at(-1)?.content) blocks.pop();
	return {
		type: "doc",
		content: blocks.length ? blocks : [{ type: "paragraph" }],
	};
}

async function importComment(
	c: Ctx,
	taskId: string,
	cm: CuComment,
	parentId: string | null,
) {
	const { db } = c.deps;
	let body = commentToDoc(cm.comment, cm.comment_text, c.users);
	const author = cm.user ? c.users[String(cm.user.id)] : undefined;
	if (!author && cm.user)
		body = {
			type: "doc",
			content: [
				para(`${who(cm.user)} wrote in ClickUp:`),
				...(body.content ?? []),
			],
		};
	const bodyText = docToText(body).slice(0, 50_000);
	const at = cm.date ? new Date(Number(cm.date)) : new Date();
	return db.transaction(async (tx) => {
		const known = await c.map.get(tx, "comment", cm.id);
		if (known) {
			const [row] = await tx
				.update(workComment)
				.set({ body, bodyText, updatedAt: new Date() })
				.where(and(eq(workComment.id, known), eq(workComment.taskId, taskId)))
				.returning({ id: workComment.id });
			if (row) {
				c.t.updated("comment");
				return row.id;
			}
		}
		const [row] = await tx
			.insert(workComment)
			.values({
				taskId,
				authorId: author ?? null,
				parentId,
				body,
				bodyText,
				createdAt: at,
				updatedAt: at,
			})
			.returning({ id: workComment.id });
		if (!row) throw new Error("comment insert failed");
		await c.map.set(tx, "comment", cm.id, row.id);
		c.t.created("comment");
		return row.id;
	});
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type Source = { listIds: string[]; projectId: string | null; name: string };

function sources(cfg: ClickUpImportConfig): Source[] {
	return cfg.targets.map((t) => ({
		listIds: t.listIds,
		projectId: t.target.kind === "existing" ? t.target.projectId : null,
		name: t.target.kind === "existing" ? t.target.projectId : t.target.name,
	}));
}

/** Matched people, plus pending invitations for those marked "invite" (nobody is emailed). */
async function people(c: Omit<Ctx, "users" | "tz">, members: CuUser[]) {
	const users: Record<string, string> = {};
	for (const [cuId, choice] of Object.entries(c.cfg.people))
		if (choice !== "unassigned" && choice !== "invite") users[cuId] = choice;
	const { db } = c.deps;
	// People the wizard left alone match org members by email.
	const open = members.filter((m) => !c.cfg.people[String(m.id)] && m.email);
	if (open.length) {
		const rows = await db
			.select({ id: user.id, email: user.email })
			.from(member)
			.innerJoin(user, eq(user.id, member.userId))
			.where(eq(member.organizationId, c.organizationId));
		for (const m of open) {
			const hit = rows.find((r) => lower(r.email) === lower(m.email as string));
			if (hit) users[String(m.id)] = hit.id;
		}
	}
	const invite = members.filter(
		(m) => c.cfg.people[String(m.id)] === "invite" && m.email,
	);
	if (invite.length && c.importerId) {
		const emails = invite.map((m) => lower(m.email as string));
		const [already, pending] = await Promise.all([
			db
				.select({ email: user.email })
				.from(member)
				.innerJoin(user, eq(user.id, member.userId))
				.where(
					and(
						eq(member.organizationId, c.organizationId),
						inArray(sql`lower(${user.email})`, emails),
					),
				),
			db
				.select({ email: invitation.email })
				.from(invitation)
				.where(
					and(
						eq(invitation.organizationId, c.organizationId),
						eq(invitation.status, "pending"),
						inArray(invitation.email, emails),
					),
				),
		]);
		const skip = new Set([...already, ...pending].map((r) => lower(r.email)));
		const fresh = emails.filter((e) => !skip.has(e));
		if (fresh.length)
			await db.insert(invitation).values(
				fresh.map((email) => ({
					id: crypto.randomUUID(),
					organizationId: c.organizationId,
					email,
					role: "developer",
					status: "pending",
					expiresAt: new Date(Date.now() + 7 * 86_400_000),
					inviterId: c.importerId as string,
				})),
			);
		if (fresh.length) c.t.created("invitation", fresh.length);
	}
	return users;
}

export async function runClickUp(
	deps: ImportDeps,
	o: {
		importId: string;
		organizationId: string;
		importerId: string | null;
		cfg: ClickUpImportConfig;
		dryRun: boolean;
		t: Tracker;
	},
): Promise<WorkImportPlan | null> {
	const api = new ClickUpApi({ token: o.cfg.token, ...deps.clickup });
	const map = idMap(o.organizationId, `clickup:${o.cfg.teamId}`);
	const base = {
		deps,
		api,
		cfg: o.cfg,
		organizationId: o.organizationId,
		importerId: o.importerId,
		map,
		t: o.t,
	};
	const [me, teams] = await Promise.all([api.user(), api.teams()]);
	const team = teams.find((x) => String(x.id) === o.cfg.teamId);
	if (!team)
		throw new Error(
			"the ClickUp workspace is no longer reachable with this token",
		);
	const tz = team.timezone || me.timezone || "UTC";
	const members = (team.members ?? []).map((m) => m.user);
	const cap = deps.attachmentCapBytes ?? DEFAULT_ATTACHMENT_CAP;
	const opts = o.cfg.options;

	// Fetch everything first: the dry run stops after counting.
	const fetched: {
		src: Source;
		lists: {
			id: string;
			name: string;
			statuses: ClickUpStatus[];
			tasks: CuTask[];
		}[];
	}[] = [];
	const allLists = sources(o.cfg).reduce((n, s) => n + s.listIds.length, 0);
	await o.t.phase("fetch", allLists);
	for (const src of sources(o.cfg)) {
		const lists = [];
		for (const listId of src.listIds) {
			const l = await api.list(listId);
			if (l.archived && !opts.archivedLists) {
				o.t.skip("list", l.name, "archived in ClickUp");
				await o.t.tick("fetch");
				continue;
			}
			lists.push({
				id: String(l.id),
				name: l.name,
				statuses: l.statuses ?? [],
				tasks: await api.tasks(listId, opts.closedTasks),
			});
			await o.t.tick("fetch");
		}
		fetched.push({ src, lists });
	}

	if (o.dryRun) {
		const count = (tasks: CuTask[]) => {
			const atts = opts.attachments
				? tasks.flatMap((x) => x.attachments ?? [])
				: [];
			for (const a of atts)
				if (Number(a.size ?? 0) > cap)
					o.t.warn(
						`Attachment "${a.title}" is over the ${Math.round(cap / 1048576)} MB cap and will be skipped`,
					);
			return {
				lists: 0,
				tasks: tasks.filter((x) => !x.parent).length,
				subtasks: tasks.filter((x) => x.parent).length,
				checklistItems: tasks.reduce(
					(n, x) =>
						n + (x.checklists ?? []).reduce((m, cl) => m + cl.items.length, 0),
					0,
				),
				attachments: atts.filter((a) => Number(a.size ?? 0) <= cap).length,
				bytes: atts.reduce(
					(n, a) => n + (Number(a.size ?? 0) <= cap ? Number(a.size ?? 0) : 0),
					0,
				),
			};
		};
		const perProject = fetched.map(({ src, lists }) => {
			const all = lists.flatMap((l) => l.tasks);
			const { bytes: _, ...counts } = count(all);
			return { target: src.name, counts: { ...counts, lists: lists.length } };
		});
		const totals: Record<string, number> = {};
		for (const p of perProject)
			for (const [k, v] of Object.entries(p.counts))
				totals[k] = (totals[k] ?? 0) + v;
		for (const [cuId, choice] of Object.entries(o.cfg.people))
			if (choice === "unassigned") {
				const m = members.find((x) => String(x.id) === cuId);
				o.t.warn(
					`${m ? who(m) : `ClickUp user ${cuId}`} has no matching member: their tasks stay unassigned`,
				);
			}
		for (const [id, f] of Object.entries(o.cfg.fields))
			if (f.mode === "skip") o.t.warn(`Custom field ${id} is skipped`);
		return {
			counts: totals,
			perProject,
			warnings: o.t.report.warnings,
			attachmentBytes: fetched.reduce(
				(n, f) => n + count(f.lists.flatMap((l) => l.tasks)).bytes,
				0,
			),
			quotaBytes: null,
		};
	}

	const c: Ctx = { ...base, tz, users: await people(base, members) };
	const download = deps.attachmentFetch ?? fetch;
	const touched = new Map<string, Set<string>>();

	for (const { src, lists } of fetched) {
		if (!src.projectId)
			throw new Error(
				`target "${src.name}" was not prepared; run the import through the API`,
			);
		const p: Project = {
			projectId: src.projectId,
			organizationId: o.organizationId,
		};
		const [wp] = await deps.db
			.select()
			.from(workProject)
			.where(eq(workProject.projectId, p.projectId));
		if (!wp) throw new Error(`project ${p.projectId} has no Work settings`);
		const ids = new Set<string>();
		touched.set(p.projectId, ids);

		await o.t.phase("structure", lists.length);
		const statusMap = await projectStatuses(
			c,
			p.projectId,
			lists.flatMap((l) => l.statuses),
		);
		const fieldMap = await projectFields(
			c,
			p.projectId,
			lists.map((l) => l.id),
		);
		const [fallback] = await deps.db
			.select({ id: workStatus.id })
			.from(workStatus)
			.where(
				and(
					eq(workStatus.projectId, p.projectId),
					eq(workStatus.category, "backlog"),
				),
			)
			.orderBy(workStatus.position)
			.limit(1);
		const maps: ClickUpMaps = {
			statuses: statusMap,
			fields: fieldMap,
			users: c.users,
			tz,
			fallbackStatusId: fallback?.id ?? "",
		};

		const local = new Map<string, string>();
		const byId = new Map(lists.flatMap((l) => l.tasks).map((x) => [x.id, x]));
		for (const l of lists) {
			const listId = await upsertList(c, p.projectId, l);
			await o.t.tick("structure");
			const tasks = [...l.tasks].sort(
				(a, b) => Number(!!topParent(a, byId)) - Number(!!topParent(b, byId)),
			);
			await o.t.phase("tasks", tasks.length);
			const [last] = await deps.db
				.select({ position: workTask.position })
				.from(workTask)
				.where(eq(workTask.listId, listId))
				.orderBy(desc(workTask.position))
				.limit(1);
			const positions = rankN(last?.position ?? null, null, tasks.length);
			let next = 0;
			for (const x of tasks) {
				const parent = topParent(x, byId);
				const related = (x.linked_tasks ?? []).flatMap((lt) => {
					const other = byId.get(lt.task_id === x.id ? lt.link_id : lt.task_id);
					return other ? [other.name] : [];
				});
				const id = await importTask(
					c,
					p,
					listId,
					x,
					parent
						? (local.get(parent) ??
								(await map.get(deps.db, "task", parent)) ??
								null)
						: null,
					maps,
					() => positions[next++] as string,
					related,
				);
				local.set(x.id, id);
				ids.add(id);
				await o.t.tick("tasks");
			}
		}

		const all = lists.flatMap((l) => l.tasks);
		await o.t.phase("checklists", all.length);
		for (const x of all) {
			const taskId = local.get(x.id);
			let checklists = x.checklists;
			if (taskId && checklists === undefined)
				checklists = (await api.task(x.id)).checklists;
			for (const cl of checklists ?? []) {
				const items = [...cl.items].sort(
					(a, b) => (a.orderindex ?? 0) - (b.orderindex ?? 0),
				);
				const ranks = rankN(null, null, items.length);
				for (const [i, item] of items.entries()) {
					if (!taskId) break;
					const text =
						(cl.name && checklists && checklists.length > 1
							? `${cl.name}: `
							: "") + item.name;
					const known = await map.get(deps.db, "checklist_item", item.id);
					if (known) {
						await deps.db
							.update(workChecklistItem)
							.set({
								text: text.slice(0, 500),
								done: item.resolved,
								updatedAt: new Date(),
							})
							.where(eq(workChecklistItem.id, known));
						c.t.updated("checklistItem");
						continue;
					}
					await deps.db.transaction(async (tx) => {
						const [row] = await tx
							.insert(workChecklistItem)
							.values({
								taskId,
								text: text.slice(0, 500),
								done: item.resolved,
								position: ranks[i] as string,
							})
							.returning({ id: workChecklistItem.id });
						if (row) await map.set(tx, "checklist_item", item.id, row.id);
					});
					c.t.created("checklistItem");
				}
			}
			await o.t.tick("checklists");
		}

		await o.t.phase("dependencies", all.length);
		for (const x of all) {
			for (const dep of x.dependencies ?? []) {
				// type 1: `task_id` is waiting on `depends_on`.
				const a = local.get(dep.task_id);
				const b = local.get(dep.depends_on);
				if (!a || !b || a === b) continue;
				const [row] = await deps.db
					.insert(workDependency)
					.values({ taskId: a, blockedById: b, createdBy: c.importerId })
					.onConflictDoNothing()
					.returning({ taskId: workDependency.taskId });
				if (row) c.t.created("dependency");
			}
			await o.t.tick("dependencies");
		}

		if (opts.comments) {
			await o.t.phase("comments", all.length);
			for (const x of all) {
				const taskId = local.get(x.id);
				if (!taskId) continue;
				for (const cm of [...(await api.comments(x.id))].reverse()) {
					const parent = await importComment(c, taskId, cm, null);
					if (Number(cm.reply_count ?? 0) > 0)
						for (const reply of await api.replies(cm.id))
							await importComment(c, taskId, reply, parent);
				}
				await o.t.tick("comments");
			}
		}

		if (opts.attachments) {
			await o.t.phase("attachments", all.length);
			for (const x of all) {
				const taskId = local.get(x.id);
				for (const a of x.attachments ?? []) {
					if (!taskId || (await map.get(deps.db, "attachment", a.id))) continue;
					if (Number(a.size ?? 0) > cap) {
						c.t.skip(
							"attachment",
							a.title,
							`over the ${Math.round(cap / 1048576)} MB cap`,
						);
						continue;
					}
					try {
						const res = await download(a.url, {
							redirect: "follow",
							signal: AbortSignal.timeout(120_000),
						} as RequestInit);
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						const bytes = new Uint8Array(await res.arrayBuffer());
						if (bytes.length > cap) {
							c.t.skip(
								"attachment",
								a.title,
								`over the ${Math.round(cap / 1048576)} MB cap`,
							);
							continue;
						}
						await deps.db.transaction(async (tx) => {
							const id = await storeImportedAttachment(deps, tx, {
								organizationId: p.organizationId,
								projectId: p.projectId,
								taskId,
								uploaderId: c.importerId,
								name: a.title,
								bytes,
							});
							await map.set(tx, "attachment", a.id, id);
						});
						c.t.created("attachment");
					} catch (e) {
						c.t.skip(
							"attachment",
							a.title,
							`not imported: ${e instanceof Error ? e.message : String(e)}`,
						);
					}
				}
				await o.t.tick("attachments");
			}
		}

		if (opts.timeEntries && wp.timeTracking) {
			await o.t.phase("time", lists.length);
			const assignees = members.map((m) => String(m.id));
			for (const l of lists) {
				for (const e of await api.timeEntries(o.cfg.teamId, l.id, assignees)) {
					const taskId = e.task ? local.get(e.task.id) : undefined;
					const userId = c.users[String(e.user.id)];
					if (!taskId || !userId) {
						c.t.skip(
							"timeEntry",
							e.description || e.id,
							!taskId ? "task not imported" : "person not matched",
						);
						continue;
					}
					const startedAt = new Date(Number(e.start));
					const durationSec = Math.max(
						0,
						Math.round(Number(e.duration ?? 0) / 1000),
					);
					if (!durationSec) continue;
					const values = {
						organizationId: o.organizationId,
						projectId: p.projectId,
						taskId,
						userId,
						startedAt,
						endedAt: e.end
							? new Date(Number(e.end))
							: new Date(startedAt.getTime() + durationSec * 1000),
						durationSec,
						note: e.description ? e.description.slice(0, 500) : null,
						billable: e.billable ?? true,
						source: "import" as const,
					};
					const known = await map.get(deps.db, "time_entry", e.id);
					if (known) {
						await deps.db
							.update(workTimeEntry)
							.set({ ...values, updatedAt: new Date() })
							.where(eq(workTimeEntry.id, known));
						c.t.updated("timeEntry");
						continue;
					}
					await deps.db.transaction(async (tx) => {
						const [row] = await tx
							.insert(workTimeEntry)
							.values(values)
							.returning({ id: workTimeEntry.id });
						if (row) await map.set(tx, "time_entry", e.id, row.id);
					});
					c.t.created("timeEntry");
				}
				await o.t.tick("time");
			}
		}
	}
	for (const [projectId, ids] of touched)
		deps.publish?.({
			organizationId: o.organizationId,
			projectId,
			entity: "task",
			op: "upsert",
			taskIds: [...ids].slice(0, 500),
			actorId: o.importerId,
		});
	return null;
}
