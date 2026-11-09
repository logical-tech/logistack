import {
	type Db,
	project,
	workAttachment,
	workBlob,
	workNotification,
	workOrgSettings,
} from "@logistack/db";
import type { BackupDestination } from "@logistack/providers";
import { and, eq, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";

/**
 * Work attachment storage (plan 10.2). Both drivers count references the same way: every
 * attachment row holds one reference to its `objectKey` and one to its `thumbKey`. The api
 * writes through these, the worker moves blobs between drivers and collects garbage.
 */
export type BlobStore = {
	driver: "db" | "s3";
	/** Where a blob with this sha256 lives in the store. */
	keyFor(sha256: string): string;
	/** Stores (or re-references) a blob. */
	put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
	read(
		key: string,
	): Promise<ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>>;
	/** Drops one reference; the bytes go when nothing references them. Call after the row is gone. */
	release(key: string): Promise<void>;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function dbBlobStore(db: Db | Tx): BlobStore {
	return {
		driver: "db",
		keyFor: (sha) => sha,
		async put(key, bytes) {
			await db
				.insert(workBlob)
				.values({ sha256: key, bytes: Buffer.from(bytes), size: bytes.length })
				.onConflictDoUpdate({
					target: workBlob.sha256,
					set: { refCount: sql`${workBlob.refCount} + 1` },
				});
		},
		async read(key) {
			const [row] = await db
				.select({ bytes: workBlob.bytes })
				.from(workBlob)
				.where(eq(workBlob.sha256, key));
			if (!row) throw new Error(`work blob ${key} is missing`);
			return new Uint8Array(row.bytes);
		},
		async release(key) {
			const [row] = await db
				.update(workBlob)
				.set({ refCount: sql`${workBlob.refCount} - 1` })
				.where(eq(workBlob.sha256, key))
				.returning({ refCount: workBlob.refCount });
			if (row && row.refCount <= 0)
				await db
					.delete(workBlob)
					.where(and(eq(workBlob.sha256, key), lte(workBlob.refCount, 0)));
		},
	};
}

/** Rows of the organization that point at `key` on S3 (soft-deleted ones included until GC). */
async function s3Refs(db: Db | Tx, organizationId: string, key: string) {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(workAttachment)
		.innerJoin(project, eq(project.id, workAttachment.projectId))
		.where(
			and(
				eq(project.organizationId, organizationId),
				eq(workAttachment.driver, "s3"),
				or(eq(workAttachment.objectKey, key), eq(workAttachment.thumbKey, key)),
			),
		);
	return row?.n ?? 0;
}

export const s3Key = (organizationId: string, sha256: string) =>
	`work/${organizationId}/${sha256}`;

/** Deduplicated per organization: an object already referenced there is not uploaded again. */
export function s3BlobStore(
	db: Db | Tx,
	dest: BackupDestination,
	organizationId: string,
): BlobStore {
	return {
		driver: "s3",
		keyFor: (sha) => s3Key(organizationId, sha),
		async put(key, bytes, contentType) {
			if ((await s3Refs(db, organizationId, key)) > 0) return;
			await dest.upload(
				key,
				new Response(bytes as Uint8Array<ArrayBuffer>)
					.body as ReadableStream<Uint8Array>,
				{ contentType },
			);
		},
		read: async (key) => dest.download(key),
		async release(key) {
			if ((await s3Refs(db, organizationId, key)) === 0)
				await dest.delete(key).catch(() => {});
		},
	};
}

export async function orgDestinationId(db: Db, organizationId: string) {
	const [row] = await db
		.select({ id: workOrgSettings.attachmentDestinationId })
		.from(workOrgSettings)
		.where(eq(workOrgSettings.organizationId, organizationId));
	return row?.id ?? null;
}

const toBytes = async (body: ReadableStream<Uint8Array> | Uint8Array) =>
	body instanceof Uint8Array
		? body
		: new Uint8Array(await new Response(body).arrayBuffer());

/**
 * `migrate-blobs`: copies every live database attachment of the organization to `dest`, flips
 * the row, then drops the database reference. Each row moves on its own, so a crashed run
 * resumes where it stopped and a second run finds nothing left. Returns how many moved.
 */
export async function migrateBlobs(
	db: Db,
	organizationId: string,
	dest: BackupDestination,
): Promise<number> {
	const from = dbBlobStore(db);
	const to = s3BlobStore(db, dest, organizationId);
	let moved = 0;
	for (;;) {
		const batch = await db
			.select({
				id: workAttachment.id,
				objectKey: workAttachment.objectKey,
				thumbKey: workAttachment.thumbKey,
				contentType: workAttachment.contentType,
			})
			.from(workAttachment)
			.innerJoin(project, eq(project.id, workAttachment.projectId))
			.where(
				and(
					eq(project.organizationId, organizationId),
					eq(workAttachment.driver, "db"),
				),
			)
			.limit(50);
		if (batch.length === 0) return moved;
		for (const a of batch) {
			const key = to.keyFor(a.objectKey);
			const thumb = a.thumbKey ? to.keyFor(a.thumbKey) : null;
			await to.put(
				key,
				await toBytes(await from.read(a.objectKey)),
				a.contentType,
			);
			if (a.thumbKey && thumb)
				await to.put(
					thumb,
					await toBytes(await from.read(a.thumbKey)),
					"image/webp",
				);
			const [flipped] = await db
				.update(workAttachment)
				.set({ driver: "s3", objectKey: key, thumbKey: thumb })
				.where(
					and(eq(workAttachment.id, a.id), eq(workAttachment.driver, "db")),
				)
				.returning({ id: workAttachment.id });
			if (!flipped) continue;
			await from.release(a.objectKey);
			if (a.thumbKey) await from.release(a.thumbKey);
			moved++;
		}
	}
}

export const WORK_GC_DAYS = 30;
export const WORK_NOTIFICATION_DAYS = 90;

/**
 * `work-gc` (daily): hard-deletes attachments soft-deleted over 30 days ago and drops their
 * blobs, removes S3 objects nothing references, and expires notifications older than 90 days.
 * `openDest` returns the organization's attachment destination, or null when it has none.
 */
export async function workGc(
	db: Db,
	now: Date,
	openDest: (organizationId: string) => Promise<BackupDestination | null>,
) {
	const cutoff = new Date(now.getTime() - WORK_GC_DAYS * 86_400_000);
	const dests = new Map<string, Promise<BackupDestination | null>>();
	const destFor = (org: string) => {
		let d = dests.get(org);
		if (!d) {
			d = openDest(org).catch(() => null);
			dests.set(org, d);
		}
		return d;
	};
	let removed = 0;
	for (;;) {
		const gone = await db
			.delete(workAttachment)
			.where(
				inArray(
					workAttachment.id,
					db
						.select({ id: workAttachment.id })
						.from(workAttachment)
						.where(
							and(
								isNotNull(workAttachment.deletedAt),
								lt(workAttachment.deletedAt, cutoff),
							),
						)
						.limit(100),
				),
			)
			.returning({
				projectId: workAttachment.projectId,
				driver: workAttachment.driver,
				objectKey: workAttachment.objectKey,
				thumbKey: workAttachment.thumbKey,
			});
		if (gone.length === 0) break;
		removed += gone.length;
		const orgs = new Map(
			(
				await db
					.select({ id: project.id, org: project.organizationId })
					.from(project)
					.where(
						inArray(project.id, [...new Set(gone.map((g) => g.projectId))]),
					)
			).map((p) => [p.id, p.org]),
		);
		for (const g of gone) {
			const keys = [g.objectKey, ...(g.thumbKey ? [g.thumbKey] : [])];
			if (g.driver === "db") {
				for (const k of keys) await dbBlobStore(db).release(k);
				continue;
			}
			const org = orgs.get(g.projectId);
			const dest = org ? await destFor(org) : null;
			// shortcut: rows do not record which destination holds them, so objects are deleted from the current one; record it per row if destinations ever change often.
			if (org && dest)
				for (const k of keys) await s3BlobStore(db, dest, org).release(k);
		}
	}
	// Leaked references (a crash between row delete and release) leave non-positive counts.
	await db.delete(workBlob).where(lte(workBlob.refCount, 0));
	let orphans = 0;
	for (const s of await db
		.select({
			org: workOrgSettings.organizationId,
			dest: workOrgSettings.attachmentDestinationId,
		})
		.from(workOrgSettings)
		.where(isNotNull(workOrgSettings.attachmentDestinationId))) {
		const dest = await destFor(s.org);
		if (!dest) continue;
		const objects = await dest.list(`work/${s.org}/`).catch(() => []);
		for (const o of objects)
			if (
				// An upload whose row is not inserted yet is not an orphan.
				o.lastModified.getTime() < now.getTime() - 3_600_000 &&
				(await s3Refs(db, s.org, o.key)) === 0
			) {
				await dest.delete(o.key).catch(() => {});
				orphans++;
			}
	}
	const expired = await db
		.delete(workNotification)
		.where(
			lt(
				workNotification.createdAt,
				new Date(now.getTime() - WORK_NOTIFICATION_DAYS * 86_400_000),
			),
		)
		.returning({ id: workNotification.id });
	return { removed, orphans, notifications: expired.length };
}
