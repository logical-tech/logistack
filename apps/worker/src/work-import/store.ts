import type { WorkImportReport } from "@logistack/contracts";
import {
	type Db,
	workAttachment,
	workBlob,
	workImport,
	workImportMap,
} from "@logistack/db";
import type { Fetch } from "@logistack/providers";
import { and, eq, sql } from "drizzle-orm";

/** Shared plumbing for Work imports (plan 12.5, 12.6): id map, progress, report, attachments. */

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

/** Same shape as the server's `WorkMessage` on the `ls:work` channel. */
export type WorkPublish = {
	organizationId: string;
	projectId: string;
	entity: "task" | "list" | "status" | "field" | "project";
	op: "upsert" | "delete";
	taskIds?: string[];
	actorId: string | null;
};

/**
 * Stores downloaded bytes as a task attachment. The default writes `work_blob`/`work_attachment`
 * rows directly (the `db` driver); the server's upload pipeline can replace it.
 */
export type StoreImportedAttachment = (
	db: DbOrTx,
	a: {
		projectId: string;
		taskId: string;
		uploaderId: string | null;
		name: string;
		contentType: string;
		bytes: Uint8Array;
	},
) => Promise<string>;

export const dbStoreImportedAttachment: StoreImportedAttachment = async (
	db,
	a,
) => {
	const sha256 = new Bun.CryptoHasher("sha256").update(a.bytes).digest("hex");
	await db
		.insert(workBlob)
		.values({ sha256, bytes: Buffer.from(a.bytes), size: a.bytes.length })
		.onConflictDoUpdate({
			target: workBlob.sha256,
			set: { refCount: sql`${workBlob.refCount} + 1` },
		});
	const [row] = await db
		.insert(workAttachment)
		.values({
			projectId: a.projectId,
			taskId: a.taskId,
			uploaderId: a.uploaderId,
			name: a.name.slice(0, 255) || "file",
			contentType: a.contentType || "application/octet-stream",
			size: a.bytes.length,
			sha256,
			driver: "db",
			objectKey: sha256,
		})
		.returning({ id: workAttachment.id });
	if (!row) throw new Error("attachment insert returned nothing");
	return row.id;
};

export type ImportDeps = {
	db: Db;
	masterKey: CryptoKey;
	publish?: (m: WorkPublish) => void;
	/** ClickUp API base and fetch (tests point them at a replay server). */
	clickup?: {
		base?: string;
		fetch?: Fetch;
		perMinute?: number;
		sleep?: (ms: number) => Promise<void>;
	};
	/** Downloads attachment URLs; production passes an SSRF-pinned fetch. */
	attachmentFetch?: Fetch;
	/** Per-file cap; larger files are skipped and reported. */
	attachmentCapBytes?: number;
	storeAttachment?: StoreImportedAttachment;
};

export const DEFAULT_ATTACHMENT_CAP = 25 * 1024 * 1024;

/** Map rows are keyed by source (not import), so a rerun of the same workspace updates the same rows. */
export function idMap(organizationId: string, source: string) {
	return {
		async get(db: DbOrTx, type: string, externalId: string) {
			const [r] = await db
				.select({ localId: workImportMap.localId })
				.from(workImportMap)
				.where(
					and(
						eq(workImportMap.organizationId, organizationId),
						eq(workImportMap.source, source),
						eq(workImportMap.externalType, type),
						eq(workImportMap.externalId, externalId),
					),
				);
			return r?.localId;
		},
		async set(
			db: DbOrTx,
			type: string,
			externalId: string,
			localId: string,
			localType = type,
		) {
			await db
				.insert(workImportMap)
				.values({
					organizationId,
					source,
					externalType: type,
					externalId,
					localId,
					localType,
				})
				.onConflictDoUpdate({
					target: [
						workImportMap.organizationId,
						workImportMap.source,
						workImportMap.externalType,
						workImportMap.externalId,
					],
					set: { localId, localType, updatedAt: new Date() },
				});
		},
	};
}

export class ImportCancelled extends Error {}

/** Counts, warnings and throttled progress for one run. */
export function tracker(db: Db, importId: string, onPhase?: () => void) {
	const report: WorkImportReport = {
		created: {},
		updated: {},
		skipped: [],
		warnings: [],
	};
	const progress: Record<
		string,
		{ phase: string; done: number; total: number }
	> = {};
	let lastWrite = 0;
	const save = async (force = false) => {
		if (!force && Date.now() - lastWrite < 1000) return;
		lastWrite = Date.now();
		const [row] = await db
			.update(workImport)
			.set({ progress, updatedAt: new Date() })
			.where(eq(workImport.id, importId))
			.returning({ status: workImport.status });
		if (row?.status === "cancelled") throw new ImportCancelled();
	};
	return {
		report,
		progress,
		created: (entity: string, n = 1) => {
			report.created[entity] = (report.created[entity] ?? 0) + n;
		},
		updated: (entity: string, n = 1) => {
			report.updated[entity] = (report.updated[entity] ?? 0) + n;
		},
		skip: (entity: string, name: string, reason: string) => {
			report.skipped.push({ entity, name: name.slice(0, 200), reason });
		},
		warn: (w: string) => {
			if (!report.warnings.includes(w)) report.warnings.push(w);
		},
		async phase(phase: string, total: number) {
			progress[phase] = { phase, done: 0, total };
			await save(true);
			onPhase?.();
		},
		async tick(phase: string, n = 1) {
			const p = progress[phase];
			if (p) p.done += n;
			await save();
		},
		flush: () => save(true),
	};
}
export type Tracker = ReturnType<typeof tracker>;
