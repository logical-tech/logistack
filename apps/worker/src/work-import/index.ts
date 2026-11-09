import type { ClickUpImportConfig, WorkImportPlan } from "@logistack/contracts";
import { decrypt, encrypt, parseCsv } from "@logistack/core";
import { workImport } from "@logistack/db";
import { eq } from "drizzle-orm";
import { runClickUp } from "./clickup.ts";
import { runCsv, type StoredCsvConfig } from "./csv.ts";
import { ImportCancelled, type ImportDeps, tracker } from "./store.ts";

export { ClickUpApi, clickUpTree, testClickUp } from "./clickup-api.ts";
export type { StoredCsvConfig } from "./csv.ts";
export type {
	ImportDeps,
	StoreImportedAttachment,
	WorkPublish,
} from "./store.ts";

/** BullMQ queue for Work background jobs; imports run as job `work-import`. */
export const WORK_QUEUE = "work";
export const WORK_IMPORT_JOB = "work-import";
export type WorkImportJob = { importId: string; dryRun: boolean };

/**
 * Runs a dry run (fetch and count, status → `ready`) or the import itself (status → `succeeded`,
 * `failed` or `cancelled`). The ClickUp token and the CSV text are wiped once a real run ends.
 */
export async function processWorkImportJob(
	deps: ImportDeps,
	job: WorkImportJob,
) {
	const { db, masterKey } = deps;
	const [row] = await db
		.select()
		.from(workImport)
		.where(eq(workImport.id, job.importId));
	if (!row?.configEncrypted || row.status === "cancelled") return;
	const cfg = JSON.parse(await decrypt(masterKey, row.configEncrypted));
	const firstProject =
		row.kind === "clickup"
			? (cfg as ClickUpImportConfig).targets.flatMap((x) =>
					x.target.kind === "existing" ? [x.target.projectId] : [],
				)[0]
			: undefined;
	const t = tracker(db, row.id, () => {
		if (firstProject)
			deps.publish?.({
				organizationId: row.organizationId,
				projectId: firstProject,
				entity: "project",
				op: "upsert",
				actorId: row.createdBy,
			});
	});
	if (!job.dryRun)
		await db
			.update(workImport)
			.set({
				status: "running",
				startedAt: new Date(),
				report: null,
				updatedAt: new Date(),
			})
			.where(eq(workImport.id, row.id));
	let status: "ready" | "succeeded" | "failed" | "cancelled" = job.dryRun
		? "ready"
		: "succeeded";
	let plan: WorkImportPlan | null = null;
	try {
		if (row.kind === "clickup")
			plan = await runClickUp(deps, {
				importId: row.id,
				organizationId: row.organizationId,
				importerId: row.createdBy,
				cfg,
				dryRun: job.dryRun,
				t,
			});
		else if (job.dryRun) {
			const rows =
				parseCsv(
					(cfg as StoredCsvConfig).csv,
					(cfg as StoredCsvConfig).delimiter,
				).length - 1;
			plan = {
				counts: { tasks: Math.max(0, rows) },
				perProject: [],
				warnings: [],
				attachmentBytes: 0,
				quotaBytes: null,
			};
		} else
			await runCsv(deps, {
				organizationId: row.organizationId,
				importerId: row.createdBy,
				cfg,
				t,
			});
	} catch (e) {
		const cancelled = e instanceof ImportCancelled;
		status = cancelled ? "cancelled" : "failed";
		if (!cancelled)
			t.warn(`Stopped: ${e instanceof Error ? e.message : String(e)}`);
	}
	const wiped = job.dryRun
		? null
		: await encrypt(masterKey, JSON.stringify({ ...cfg, token: "", csv: "" }));
	await db
		.update(workImport)
		.set({
			status,
			progress: t.progress,
			...(job.dryRun
				? {
						plan: plan ?? {
							counts: {},
							perProject: [],
							warnings: t.report.warnings,
							attachmentBytes: 0,
							quotaBytes: null,
						},
					}
				: { report: t.report, finishedAt: new Date() }),
			...(wiped ? { configEncrypted: wiped } : {}),
			updatedAt: new Date(),
		})
		.where(eq(workImport.id, row.id));
}
