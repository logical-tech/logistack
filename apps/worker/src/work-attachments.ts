import {
	type Db,
	project,
	workAttachment,
	workOrgSettings,
} from "@logistack/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { log } from "./bus.ts";
import type { BlobStore } from "./work-blobs.ts";

/**
 * The attachment upload pipeline (plan 10.1) shared by the api's upload route and the worker's
 * imports: sniffing, image processing, hashing, quota, storing through a `BlobStore`.
 */

const GB = 1024 ** 3;
/** Default quota while attachments live in Postgres. */
export const DB_QUOTA_GB = 2;

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
	sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, len: number) =>
	String.fromCharCode(...b.subarray(at, at + len));

const TEXT_TYPES: Record<string, string> = {
	csv: "text/csv",
	md: "text/markdown",
	markdown: "text/markdown",
	json: "application/json",
};

/**
 * The content type from magic bytes, never from the client. Text is recognised by being valid
 * UTF-8 without NUL bytes, then named by extension; SVG is detected so it can be refused inline.
 */
export function sniffContentType(b: Uint8Array, name: string): string {
	if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
	if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (ascii(b, 0, 4) === "GIF8") return "image/gif";
	if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP")
		return "image/webp";
	if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE")
		return "audio/wav";
	if (ascii(b, 0, 5) === "%PDF-") return "application/pdf";
	if (ascii(b, 4, 4) === "ftyp") {
		const brand = ascii(b, 8, 4);
		if (brand === "avif" || brand === "avis") return "image/avif";
		if (["heic", "heix", "heim", "heis", "mif1", "msf1"].includes(brand))
			return "image/heic";
		if (brand === "qt  ") return "video/quicktime";
		return "video/mp4";
	}
	if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
	if (
		ascii(b, 0, 3) === "ID3" ||
		(b[0] === 0xff && b[1] !== undefined && (b[1] & 0xe0) === 0xe0)
	)
		return "audio/mpeg";
	if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) {
		// Office files are zips whose entry names say which.
		const head = ascii(b, 0, Math.min(b.length, 65_536));
		if (head.includes("word/"))
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		if (head.includes("xl/"))
			return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		if (head.includes("ppt/"))
			return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
		return "application/zip";
	}
	if (b.includes(0)) return "application/octet-stream";
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(
			b.subarray(0, 65_536),
		);
	} catch {
		// A cut multi-byte character at the 64 KB boundary is still text.
		if (b.length <= 65_536) return "application/octet-stream";
		text = new TextDecoder().decode(b.subarray(0, 65_000));
	}
	const start = text
		.replace(/^﻿/, "")
		.replace(
			/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?/i,
			"",
		);
	if (/^<svg[\s>]/i.test(start)) return "image/svg+xml";
	const ext = name.toLowerCase().split(".").pop() ?? "";
	return TEXT_TYPES[ext] ?? "text/plain; charset=utf-8";
}

/** Raster images get EXIF stripped and a thumbnail; SVG never (it is served as a download). */
const RASTER = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/heic",
]);
export const isRaster = (type: string) => RASTER.has(type);

/** Served inline: raster images, PDF, audio and video. Everything else downloads. */
export const servedInline = (type: string) =>
	isRaster(type) ||
	type === "application/pdf" ||
	type.startsWith("audio/") ||
	type.startsWith("video/");

/** `name` without paths or control characters, at most 255 characters. */
export function cleanName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
	const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return (clean || "file").slice(0, 255);
}

type Sharp = typeof import("sharp").default;
let sharpLoad: Promise<Sharp | null> | undefined;

/** `sharp` when its native binary loads on this platform; otherwise images are kept as sent. */
export function loadSharp(): Promise<Sharp | null> {
	sharpLoad ??= import("sharp")
		.then((m) => m.default)
		.catch((error: unknown) => {
			log(
				"warn",
				"sharp unavailable: attachments keep EXIF and get no thumbnails",
				{
					error: String(error),
				},
			);
			return null;
		});
	return sharpLoad;
}

export type ProcessedImage = {
	bytes: Uint8Array;
	width: number | null;
	height: number | null;
	thumb: Uint8Array | null;
};

/**
 * Rotates by EXIF orientation and re-encodes without metadata (GPS stays private), records
 * the size and makes a 480 px wide WebP thumbnail. GIF and HEIC keep their bytes (GIF has no
 * EXIF; HEIC is not re-encodable here) and get a thumbnail when libvips can read them.
 */
export async function processImage(
	bytes: Uint8Array,
	type: string,
): Promise<ProcessedImage> {
	const sharp = await loadSharp();
	if (!sharp) return { bytes, width: null, height: null, thumb: null };
	try {
		let out = bytes;
		if (
			type === "image/jpeg" ||
			type === "image/png" ||
			type === "image/webp" ||
			type === "image/avif"
		) {
			const img = sharp(bytes).rotate();
			const format = type.slice("image/".length) as
				| "jpeg"
				| "png"
				| "webp"
				| "avif";
			out = new Uint8Array(
				await (format === "jpeg"
					? img.jpeg({ quality: 90 })
					: img.toFormat(format)
				).toBuffer(),
			);
		}
		const meta = await sharp(out).metadata();
		const thumb = new Uint8Array(
			await sharp(out)
				.rotate()
				.resize({ width: 480, withoutEnlargement: true })
				.webp({ quality: 80 })
				.toBuffer(),
		);
		return {
			bytes: out,
			width: meta.width ?? null,
			height: meta.pageHeight ?? meta.height ?? null,
			thumb,
		};
	} catch (error) {
		log("warn", "image not processed", { type, error: String(error) });
		return { bytes, width: null, height: null, thumb: null };
	}
}

export const sha256Hex = (bytes: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Used bytes and the effective quota (null: unlimited) of an organization. */
export async function attachmentQuota(db: Db, organizationId: string) {
	const [s] = await db
		.select()
		.from(workOrgSettings)
		.where(eq(workOrgSettings.organizationId, organizationId));
	const [used] = await db
		.select({ n: sql<string>`coalesce(sum(${workAttachment.size}), 0)` })
		.from(workAttachment)
		.innerJoin(project, eq(project.id, workAttachment.projectId))
		.where(
			and(
				eq(project.organizationId, organizationId),
				isNull(workAttachment.deletedAt),
			),
		);
	const gb =
		s?.attachmentQuotaGb ?? (s?.attachmentDestinationId ? null : DB_QUOTA_GB);
	return {
		quotaGb: s?.attachmentQuotaGb ?? null,
		quotaBytes: gb === null ? null : gb * GB,
		usedBytes: Number(used?.n ?? 0),
		destinationId: s?.attachmentDestinationId ?? null,
	};
}

export type PreparedAttachment = ProcessedImage & {
	name: string;
	contentType: string;
};

/** Cleans the name, sniffs the type and processes raster images. */
export async function prepareAttachment(
	raw: Uint8Array,
	name: string,
): Promise<PreparedAttachment> {
	const clean = cleanName(name);
	const contentType = sniffContentType(raw, clean);
	const image = isRaster(contentType)
		? await processImage(raw, contentType)
		: { bytes: raw, width: null, height: null, thumb: null };
	return { ...image, name: clean, contentType };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof workAttachment.$inferSelect;

/**
 * Stores the bytes (and thumbnail) in `store`, then inserts the row in a transaction that also
 * runs `inTx`. A failed insert drops the references it took.
 */
export async function saveAttachment(
	db: Db | Tx,
	store: BlobStore,
	p: PreparedAttachment,
	row: Pick<
		typeof workAttachment.$inferInsert,
		"projectId" | "taskId" | "commentId" | "inlineIn" | "uploaderId"
	>,
	inTx?: (tx: Tx, r: Row) => Promise<void>,
): Promise<Row> {
	const sha = sha256Hex(p.bytes);
	const key = store.keyFor(sha);
	const thumbKey = p.thumb ? store.keyFor(sha256Hex(p.thumb)) : null;
	await store.put(key, p.bytes, p.contentType);
	if (thumbKey && p.thumb) await store.put(thumbKey, p.thumb, "image/webp");
	try {
		return await db.transaction(async (tx) => {
			const [r] = await tx
				.insert(workAttachment)
				.values({
					...row,
					name: p.name,
					contentType: p.contentType,
					size: p.bytes.length,
					sha256: sha,
					driver: store.driver,
					objectKey: key,
					width: p.width,
					height: p.height,
					thumbKey,
				})
				.returning();
			if (!r) throw new Error("attachment not inserted");
			await inTx?.(tx, r);
			return r;
		});
	} catch (error) {
		await store.release(key);
		if (thumbKey) await store.release(thumbKey);
		throw error;
	}
}
