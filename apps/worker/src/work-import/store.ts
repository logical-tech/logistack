import type { WorkImportReport } from "@logistack/contracts";
import { type Db, workImport, workImportMap } from "@logistack/db";
import type { BackupDestination, Fetch } from "@logistack/providers";
import { and, eq } from "drizzle-orm";
import {
	attachmentQuota,
	prepareAttachment,
	saveAttachment,
} from "../work-attachments.ts";
import { dbBlobStore, s3BlobStore } from "../work-blobs.ts";

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
 * Stores downloaded bytes as a task attachment through the upload pipeline (sniffing, EXIF
 * strip, thumbnail, dedup, the organization's driver); throws when the quota is exceeded.
 */
export async function storeImportedAttachment(
	deps: ImportDeps,
	db: DbOrTx,
	a: {
		organizationId: string;
		projectId: string;
		taskId: string;
		uploaderId: string | null;
		name: string;
		bytes: Uint8Array;
	},
): Promise<string> {
	const p = await prepareAttachment(a.bytes, a.name);
	const q = await attachmentQuota(deps.db, a.organizationId);
	if (q.quotaBytes !== null && q.usedBytes + p.bytes.length > q.quotaBytes)
		throw new Error(
			`attachment quota exceeded: ${q.usedBytes + p.bytes.length} of ${q.quotaBytes} bytes`,
		);
	const dest = q.destinationId
		? await deps.openDestination?.(a.organizationId)
		: null;
	if (q.destinationId && !dest)
		throw new Error("the attachment destination can't be opened");
	const store = dest
		? s3BlobStore(db, dest, a.organizationId)
		: dbBlobStore(db);
	const row = await saveAttachment(db, store, p, {
		projectId: a.projectId,
		taskId: a.taskId,
		uploaderId: a.uploaderId,
	});
	return row.id;
}

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
	/** The organization's attachment destination; without it S3-configured orgs can't import files. */
	openDestination?: (
		organizationId: string,
	) => Promise<BackupDestination | null>;
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
