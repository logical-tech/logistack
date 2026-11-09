import type {
	CsvImportConfig,
	WorkFieldConfig,
	WorkPriority,
} from "@logistack/contracts";
import {
	docToText,
	parseCsv,
	parseCsvDate,
	parseFieldValue,
	rankBetween,
	rankN,
} from "@logistack/core";
import {
	member,
	user,
	workActivity,
	workField,
	workFieldValue,
	workList,
	workProject,
	workStatus,
	workTag,
	workTask,
	workTaskAssignee,
	workTaskTag,
} from "@logistack/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { type ImportDeps, idMap, type Tracker } from "./store.ts";

/** CSV import (plan 12.6) into one list: each mapped column becomes a task property or field value. */

export type StoredCsvConfig = z.output<typeof CsvImportConfig> & {
	csv: string;
};

const PRIORITIES: Record<string, WorkPriority> = {
	urgent: "urgent",
	high: "high",
	normal: "normal",
	medium: "normal",
	low: "low",
	none: "none",
	"1": "urgent",
	"2": "high",
	"3": "normal",
	"4": "low",
};

const lower = (s: string) => s.trim().toLowerCase();

export async function runCsv(
	deps: ImportDeps,
	o: {
		organizationId: string;
		importerId: string | null;
		cfg: StoredCsvConfig;
		t: Tracker;
	},
) {
	const { db } = deps;
	const { cfg, t } = o;
	const [list] = await db
		.select()
		.from(workList)
		.where(eq(workList.id, cfg.listId));
	if (!list) throw new Error("the target list no longer exists");
	const projectId = list.projectId;
	const [wp] = await db
		.select()
		.from(workProject)
		.where(eq(workProject.projectId, projectId));
	if (!wp) throw new Error("the project has no Work settings");
	const rows = parseCsv(cfg.csv, cfg.delimiter).slice(1);
	const map = idMap(o.organizationId, `csv:${projectId}`);

	const statuses = await db
		.select()
		.from(workStatus)
		.where(eq(workStatus.projectId, projectId))
		.orderBy(asc(workStatus.position));
	const fallback =
		statuses.find((s) => s.category === "backlog") ?? statuses[0];
	if (!fallback) throw new Error("the project has no statuses");
	const people = await db
		.select({ id: user.id, name: user.name, email: user.email })
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(eq(member.organizationId, o.organizationId));
	const person = (v: string) =>
		people.find(
			(p) => lower(p.email) === lower(v) || lower(p.name) === lower(v),
		)?.id;

	// Columns → fields, creating the new ones first.
	const fields = new Map<string, { id: string; config: WorkFieldConfig }>();
	const existing = await db
		.select()
		.from(workField)
		.where(eq(workField.projectId, projectId))
		.orderBy(desc(workField.position));
	let lastFieldPos = existing[0]?.position ?? null;
	for (const [col, target] of Object.entries(cfg.columns)) {
		if (target.to === "field") {
			const f = existing.find((x) => x.id === target.fieldId);
			if (f) fields.set(col, { id: f.id, config: f.config });
		} else if (target.to === "new_field") {
			const found = existing.find(
				(x) => x.listId === null && lower(x.name) === lower(target.name),
			);
			if (found) {
				fields.set(col, { id: found.id, config: found.config });
				continue;
			}
			lastFieldPos = rankBetween(lastFieldPos, null);
			const [row] = await db
				.insert(workField)
				.values({
					projectId,
					name: target.name.slice(0, 100),
					kind: target.config.kind,
					config: target.config,
					position: lastFieldPos,
				})
				.returning({ id: workField.id });
			if (row) {
				fields.set(col, { id: row.id, config: target.config });
				t.created("field");
			}
		}
	}
	const colOf = (to: string) =>
		Object.entries(cfg.columns).find(([, v]) => v.to === to);
	const cell = (row: string[], col: string | undefined) =>
		col === undefined ? "" : (row[Number(col)] ?? "").trim();

	const [last] = await db
		.select({ position: workTask.position })
		.from(workTask)
		.where(eq(workTask.listId, cfg.listId))
		.orderBy(desc(workTask.position))
		.limit(1);
	const positions = rankN(last?.position ?? null, null, rows.length);
	await t.phase("tasks", rows.length);
	const created: {
		id: string;
		title: string;
		externalId: string;
		parentRef: string;
	}[] = [];
	const [titleCol] = colOf("title") ?? [];
	const [externalCol] = colOf("externalId") ?? [];
	const [parentCol] = colOf("parent") ?? [];
	for (const [i, row] of rows.entries()) {
		const line = i + 2;
		const title = cell(row, titleCol).slice(0, 500);
		if (!title) {
			t.skip("row", `line ${line}`, "no title");
			await t.tick("tasks");
			continue;
		}
		let statusId = fallback.id;
		let priority: WorkPriority = "none";
		let startDate: string | null = null;
		let dueDate: string | null = null;
		let description: string | null = null;
		const assignees: string[] = [];
		const tags: string[] = [];
		const values: Record<string, unknown> = {};
		for (const [col, target] of Object.entries(cfg.columns)) {
			const v = cell(row, col);
			if (!v) continue;
			switch (target.to) {
				case "description":
					description = v;
					break;
				case "status": {
					const id =
						target.map?.[v] ??
						statuses.find((s) => lower(s.name) === lower(v))?.id;
					if (id && statuses.some((s) => s.id === id)) statusId = id;
					else
						t.warn(
							`Status "${v}" has no match; those rows went to ${fallback.name}`,
						);
					break;
				}
				case "assignee":
					for (const part of v.split(/[;,]/)) {
						const id = person(part);
						if (id) assignees.push(id);
						else if (part.trim())
							t.warn(`"${part.trim()}" is not a member; left unassigned`);
					}
					break;
				case "priority":
					priority = PRIORITIES[lower(v)] ?? "none";
					break;
				case "startDate":
				case "dueDate": {
					const d = parseCsvDate(v, target.dateFormat);
					if (!d)
						t.warn(
							`Line ${line}: "${v}" is not a date in ${target.dateFormat ?? "YYYY-MM-DD"}`,
						);
					else if (target.to === "startDate") startDate = d;
					else dueDate = d;
					break;
				}
				case "tags":
					tags.push(
						...v
							.split(/[;,]/)
							.map((x) => x.trim())
							.filter(Boolean),
					);
					break;
				case "field":
				case "new_field": {
					const f = fields.get(col);
					if (!f) break;
					const raw = f.config.kind === "multi_select" ? v.split(/;\s*/) : v;
					const parsed = parseFieldValue({ config: f.config }, raw);
					if (parsed.ok && parsed.value !== null) values[f.id] = parsed.value;
					else t.warn(`Line ${line}: "${v}" doesn't fit field ${f.id}`);
					break;
				}
			}
		}
		if (startDate && dueDate && startDate > dueDate) startDate = dueDate;
		const doc = description
			? {
					type: "doc" as const,
					content: description.split(/\n{2,}/).map((p) => ({
						type: "paragraph",
						content: [{ type: "text", text: p }],
					})),
				}
			: null;
		const externalId = cell(row, externalCol);
		const taskValues = {
			title,
			statusId,
			priority,
			startDate,
			dueDate,
			description: doc,
			descriptionText: doc ? docToText(doc) : null,
			source: { kind: "csv" as const, ...(externalId ? { externalId } : {}) },
		};
		const id = await db.transaction(async (tx) => {
			const known = externalId
				? await map.get(tx, "task", externalId)
				: undefined;
			if (known) {
				const [r] = await tx
					.update(workTask)
					.set({ ...taskValues, updatedAt: new Date() })
					.where(and(eq(workTask.id, known), eq(workTask.projectId, projectId)))
					.returning({ id: workTask.id });
				if (r) {
					t.updated("task");
					return r.id;
				}
			}
			const [n] = await tx
				.update(workProject)
				.set({ nextNumber: sql`${workProject.nextNumber} + 1` })
				.where(eq(workProject.projectId, projectId))
				.returning({ n: sql<number>`${workProject.nextNumber} - 1` });
			const [r] = await tx
				.insert(workTask)
				.values({
					...taskValues,
					projectId,
					listId: cfg.listId,
					number: Number(n?.n),
					position: positions[i] as string,
					createdBy: o.importerId,
				})
				.returning({ id: workTask.id });
			if (!r) throw new Error("task insert failed");
			await tx.insert(workActivity).values({
				taskId: r.id,
				actorId: o.importerId,
				kind: "imported",
				data: { source: "csv" },
			});
			if (externalId) await map.set(tx, "task", externalId, r.id);
			t.created("task");
			return r.id;
		});
		await db.delete(workTaskAssignee).where(eq(workTaskAssignee.taskId, id));
		if (assignees.length)
			await db
				.insert(workTaskAssignee)
				.values(
					[...new Set(assignees)].slice(0, 20).map((userId) => ({
						taskId: id,
						userId,
						assignedBy: o.importerId,
					})),
				)
				.onConflictDoNothing();
		for (const name of tags) {
			await db
				.insert(workTag)
				.values({ projectId, name: name.slice(0, 60), color: "gray" })
				.onConflictDoNothing();
			const [tag] = await db
				.select({ id: workTag.id })
				.from(workTag)
				.where(
					and(
						eq(workTag.projectId, projectId),
						sql`lower(${workTag.name}) = ${lower(name.slice(0, 60))}`,
					),
				);
			if (tag)
				await db
					.insert(workTaskTag)
					.values({ taskId: id, tagId: tag.id })
					.onConflictDoNothing();
		}
		for (const [fieldId, value] of Object.entries(values))
			await db
				.insert(workFieldValue)
				.values({ taskId: id, fieldId, value, updatedBy: o.importerId })
				.onConflictDoUpdate({
					target: [workFieldValue.taskId, workFieldValue.fieldId],
					set: { value, updatedAt: new Date() },
				});
		created.push({ id, title, externalId, parentRef: cell(row, parentCol) });
		await t.tick("tasks");
	}

	// Parents second, so a row may name a parent further down the file.
	for (const x of created) {
		if (!x.parentRef) continue;
		const parent =
			created.find((y) => y.externalId && y.externalId === x.parentRef) ??
			created.find((y) => lower(y.title) === lower(x.parentRef));
		if (!parent || parent.id === x.id) {
			t.warn(`Parent "${x.parentRef}" not found in the file`);
			continue;
		}
		if (created.find((y) => y.id === parent.id)?.parentRef) {
			t.warn(
				`"${x.title}": subtasks can't have subtasks; kept at the top level`,
			);
			continue;
		}
		await db
			.update(workTask)
			.set({ parentId: parent.id })
			.where(eq(workTask.id, x.id));
	}
	deps.publish?.({
		organizationId: o.organizationId,
		projectId,
		entity: "task",
		op: "upsert",
		taskIds: created.map((x) => x.id).slice(0, 500),
		actorId: o.importerId,
	});
}
