import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decrypt } from "@logistack/core";
import {
	project,
	workAttachment,
	workChecklistItem,
	workComment,
	workDependency,
	workField,
	workFieldValue,
	workImport,
	workStatus,
	workTask,
	workTaskAssignee,
	workTimeEntry,
} from "@logistack/db";
import { processWorkImportJob } from "@logistack/worker/work-import";
import { and, asc, eq, inArray } from "drizzle-orm";
import { hasDocker } from "./harness.ts";
import { startClickUpReplay } from "./work-extras-b-clickup-replay.ts";
import { type WorkHarness, workHarness } from "./work-extras-b-fixtures.ts";

describe.skipIf(!hasDocker)("work imports", () => {
	let w: WorkHarness;
	let replay: ReturnType<typeof startClickUpReplay>;
	let ownerId: string;

	const deps = () => ({
		db: w.h.deps.db,
		masterKey: w.h.deps.masterKey,
		clickup: { base: replay.base },
		attachmentFetch: fetch,
		attachmentCapBytes: 1024 * 1024,
	});
	const config = () => ({
		token: "pk_test_token_123",
		teamId: "9001",
		targets: [
			{
				sourceId: "S1",
				sourceType: "space" as const,
				listIds: ["L1"],
				target: { kind: "new" as const, name: "From ClickUp", folderId: null },
			},
		],
		statuses: {},
		fields: {},
		people: { "101": ownerId, "102": "unassigned" as const },
		options: {
			closedTasks: true,
			comments: true,
			attachments: true,
			timeEntries: true,
			archivedLists: false,
			keepUrls: true,
		},
	});
	const importRow = async (id: string) =>
		(
			await w.h.deps.db.select().from(workImport).where(eq(workImport.id, id))
		)[0];
	const create = async () => {
		const res = await w.h.call("POST", "/api/work/imports", {
			...w.as(),
			body: { kind: "clickup", config: config() },
		});
		expect(res.status).toBe(201);
		return res.json.id as string;
	};
	const run = async (id: string) => {
		const res = await w.h.call("POST", `/api/work/imports/${id}/run`, w.as());
		expect(res.status).toBe(202);
		expect(res.json.status).toBe("running");
		await processWorkImportJob(deps(), { importId: id, dryRun: false });
		return importRow(id);
	};
	const importedProject = async () => {
		const [p] = await w.h.deps.db
			.select()
			.from(project)
			.where(eq(project.name, "From ClickUp"));
		return p?.id as string;
	};

	beforeAll(async () => {
		w = await workHarness("import");
		ownerId = (await w.h.call("GET", "/api/me", w.as())).json.userId;
		replay = startClickUpReplay();
	}, 90_000);
	afterAll(async () => {
		replay?.server.stop(true);
		await w?.h.close();
	});

	test("dry run counts without writing", async () => {
		const id = await create();
		expect(
			(await w.h.call("POST", `/api/work/imports/${id}/dry-run`, w.as()))
				.status,
		).toBe(202);
		await processWorkImportJob(deps(), { importId: id, dryRun: true });
		const got = await w.h.call("GET", `/api/work/imports/${id}`, w.as());
		expect(got.json.status).toBe("ready");
		expect(got.json.plan.counts).toMatchObject({
			lists: 1,
			tasks: 2,
			subtasks: 2,
			checklistItems: 2,
			attachments: 1,
		});
		expect(got.json.plan.attachmentBytes).toBe(8);
		expect(got.json.plan.warnings.join("\n")).toContain("video.mov");
		expect(got.json.plan.warnings.join("\n")).toContain("Jane");
		expect(await importedProject()).toBeUndefined();
		// Pagination and the 429 backoff: page 1 was asked twice.
		expect(
			replay.requests.filter((r) => r.startsWith("/list/L1/task?page=1"))
				.length,
		).toBe(2);
	}, 30_000);

	test("run creates the project and everything in order, then wipes the token", async () => {
		const row = await run(await create());
		expect(row?.status).toBe("succeeded");
		expect(row?.report?.created).toMatchObject({
			task: 4,
			list: 1,
			checklistItem: 2,
			dependency: 1,
			comment: 2,
			attachment: 1,
			timeEntry: 1,
		});
		expect(
			row?.report?.skipped.map((s) => `${s.entity}:${s.name}`).sort(),
		).toEqual(["attachment:video.mov", "field:Score", "timeEntry:TE2"]);
		expect(
			JSON.parse(await decrypt(w.h.deps.masterKey, row?.configEncrypted ?? ""))
				.token,
		).toBe("");

		const projectId = await importedProject();
		const db = w.h.deps.db;
		const tasks = await db
			.select()
			.from(workTask)
			.where(eq(workTask.projectId, projectId))
			.orderBy(asc(workTask.number));
		const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]));
		const t1 = byTitle["Launch homepage"];
		expect(t1).toMatchObject({
			priority: "high",
			dueDate: "2026-12-01",
			dueTime: "11:00:00",
			startDate: "2026-11-20",
			source: {
				kind: "clickup",
				externalId: "T1",
				url: "https://app.clickup.com/t/T1",
			},
		});
		expect(t1?.descriptionText).toContain("Ship the new hero.");
		expect(t1?.descriptionText).toContain(
			"Originally assigned to Jane (jane@x.example).",
		);
		// Parents first; the grandchild hangs off the top-level parent (one subtask level).
		expect(byTitle["Write copy"]?.parentId).toBe(t1?.id);
		expect(byTitle.Proofread?.parentId).toBe(t1?.id);

		const statuses = await db
			.select()
			.from(workStatus)
			.where(eq(workStatus.projectId, projectId));
		const cat = (id?: string) => statuses.find((s) => s.id === id)?.category;
		// "to do" lands on the seeded "To do" status: an existing name wins over a new status.
		expect(statuses.find((s) => s.id === t1?.statusId)?.name).toBe("To do");
		expect(
			statuses.find((s) => s.id === byTitle["Write copy"]?.statusId),
		).toMatchObject({ name: "In review", category: "active", color: "violet" });
		expect(cat(byTitle["Pick fonts"]?.statusId)).toBe("done");

		expect(
			await db
				.select({ u: workTaskAssignee.userId })
				.from(workTaskAssignee)
				.where(eq(workTaskAssignee.taskId, t1?.id ?? "")),
		).toEqual([{ u: ownerId }]);
		const values = await db
			.select({ name: workField.name, value: workFieldValue.value })
			.from(workFieldValue)
			.innerJoin(workField, eq(workField.id, workFieldValue.fieldId))
			.where(eq(workFieldValue.taskId, t1?.id ?? ""));
		expect(Object.fromEntries(values.map((v) => [v.name, v.value]))).toEqual({
			Budget: 1200.5,
			Size: "o-l",
		});
		expect(
			(
				await db
					.select()
					.from(workChecklistItem)
					.where(eq(workChecklistItem.taskId, t1?.id ?? ""))
			)
				.map((i) => [i.text, i.done])
				.sort(),
		).toEqual([
			["Desktop", false],
			["Mobile", true],
		]);
		expect(
			await db
				.select()
				.from(workDependency)
				.where(eq(workDependency.taskId, t1?.id ?? "")),
		).toMatchObject([{ blockedById: byTitle["Pick fonts"]?.id }]);
		const comments = await db
			.select()
			.from(workComment)
			.where(eq(workComment.taskId, t1?.id ?? ""))
			.orderBy(asc(workComment.createdAt));
		expect(comments.map((c) => [c.authorId, c.bodyText, !!c.parentId])).toEqual(
			[
				[
					null,
					"Jane (jane@x.example) wrote in ClickUp:\nLooks great @Olivia",
					false,
				],
				[ownerId, "Thanks!", true],
			],
		);
		expect(
			(
				await db
					.select()
					.from(workAttachment)
					.where(eq(workAttachment.taskId, t1?.id ?? ""))
			).map((a) => [a.name, a.size, a.contentType]),
			// Through the upload pipeline: the type is sniffed from the bytes (not a whole PNG), not taken from ClickUp.
		).toEqual([["hero.png", 8, "application/octet-stream"]]);
		expect(
			await db
				.select()
				.from(workTimeEntry)
				.where(eq(workTimeEntry.taskId, t1?.id ?? "")),
		).toMatchObject([
			{ userId: ownerId, durationSec: 5400, note: "Pairing", source: "import" },
		]);
	}, 30_000);

	test("a rerun updates instead of duplicating", async () => {
		const row = await run(await create());
		expect(row?.status).toBe("succeeded");
		expect(row?.report?.created.task ?? 0).toBe(0);
		expect(row?.report?.updated.task).toBe(4);
		const projects = await w.h.deps.db
			.select()
			.from(project)
			.where(eq(project.name, "From ClickUp"));
		expect(projects.length).toBe(1);
		const ids = projects.map((p) => p.id);
		expect(
			(
				await w.h.deps.db
					.select()
					.from(workTask)
					.where(inArray(workTask.projectId, ids))
			).length,
		).toBe(4);
		expect(
			(
				await w.h.deps.db
					.select()
					.from(workComment)
					.innerJoin(workTask, eq(workTask.id, workComment.taskId))
					.where(inArray(workTask.projectId, ids))
			).length,
		).toBe(2);
		expect(
			(
				await w.h.deps.db
					.select()
					.from(workAttachment)
					.where(inArray(workAttachment.projectId, ids))
			).length,
		).toBe(1);
	}, 30_000);

	test("a finished import can't run again; cancel stops a draft", async () => {
		const [done] = await w.h.deps.db
			.select()
			.from(workImport)
			.where(eq(workImport.status, "succeeded"))
			.limit(1);
		expect(
			(await w.h.call("POST", `/api/work/imports/${done?.id}/run`, w.as()))
				.status,
		).toBe(409);
		const id = await create();
		const cancelled = await w.h.call(
			"POST",
			`/api/work/imports/${id}/cancel`,
			w.as(),
		);
		expect(cancelled.json.status).toBe("cancelled");
		expect(
			(await w.h.call("POST", `/api/work/imports/${id}/run`, w.as())).status,
		).toBe(409);
	});

	test("CSV: upload, map, import into a list", async () => {
		const p = await w.newProject("Csv target");
		const csv =
			"Title;Status;Owner;Due;Parent;Ref\nSetup;In progress;owner@example.com;31/12/2026;;r1\nChild;Nope;ghost@x.example;soon;Setup;r2\n;;;;;\n";
		const form = new FormData();
		form.set("file", new File([csv], "tasks.csv", { type: "text/csv" }));
		const up = await w.h.app.request("/api/work/imports/csv/upload", {
			method: "POST",
			headers: { cookie: w.cookie, origin: w.h.config.WEB_ORIGIN },
			body: form,
		});
		expect(up.status).toBe(200);
		const upload = (await up.json()) as { uploadId: string };
		expect(upload).toMatchObject({
			delimiter: ";",
			encoding: "utf-8",
			headers: ["Title", "Status", "Owner", "Due", "Parent", "Ref"],
			rowCount: 2,
		});
		const res = await w.h.call("POST", "/api/work/imports", {
			...w.as(),
			body: {
				kind: "csv",
				config: {
					listId: p.listId,
					delimiter: ";",
					uploadId: upload.uploadId,
					columns: {
						"0": { to: "title" },
						"1": { to: "status" },
						"2": { to: "assignee" },
						"3": { to: "dueDate", dateFormat: "DD/MM/YYYY" },
						"4": { to: "parent" },
						"5": { to: "externalId" },
					},
				},
			},
		});
		expect(res.status).toBe(201);
		const row = await run(res.json.id);
		expect(row?.status).toBe("succeeded");
		expect(row?.report?.created.task).toBe(2);
		expect(row?.report?.warnings.join("\n")).toContain("ghost@x.example");
		const tasks = await w.h.deps.db
			.select({
				id: workTask.id,
				title: workTask.title,
				parentId: workTask.parentId,
				dueDate: workTask.dueDate,
				category: workStatus.category,
			})
			.from(workTask)
			.innerJoin(workStatus, eq(workStatus.id, workTask.statusId))
			.where(and(eq(workTask.projectId, p.id)))
			.orderBy(asc(workTask.number));
		expect(tasks.map((t) => [t.title, t.category, t.dueDate])).toEqual([
			["Setup", "active", "2026-12-31"],
			["Child", "backlog", null],
		]);
		expect(tasks[1]?.parentId).toBe(tasks[0]?.id);
	}, 30_000);
});
