import type { WorkAttachment } from "@logistack/contracts";
import {
	instanceSettings,
	project,
	workAttachment,
	workOrgSettings,
} from "@logistack/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Deps, Env } from "../env.ts";
import { Failure } from "../errors.ts";
import { log } from "../log.ts";

/** Upload pipeline helpers (plan 10.1): cap, sniffing, image processing, quota. */

export const DEFAULT_MAX_MB = 25;
export const MAX_MB = 100;
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

export async function maxUploadBytes(deps: Deps) {
	const [s] = await deps.db
		.select({ mb: instanceSettings.workAttachmentMaxMb })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return Math.min(s?.mb ?? DEFAULT_MAX_MB, MAX_MB) * 1024 * 1024;
}

/** Used bytes and the effective quota (null: unlimited) of an organization. */
export async function quotaOf(deps: Deps, organizationId: string) {
	const [s] = await deps.db
		.select()
		.from(workOrgSettings)
		.where(eq(workOrgSettings.organizationId, organizationId));
	const [used] = await deps.db
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

export async function assertQuota(
	deps: Deps,
	organizationId: string,
	adding: number,
) {
	const q = await quotaOf(deps, organizationId);
	if (q.quotaBytes !== null && q.usedBytes + adding > q.quotaBytes)
		throw new Failure(
			"conflict",
			`attachment quota exceeded: ${q.usedBytes + adding} of ${q.quotaBytes} bytes`,
			{
				reason: "quota_exceeded",
				usedBytes: q.usedBytes,
				quotaBytes: q.quotaBytes,
				adding,
			},
		);
}

/**
 * Route middleware: reads the body into memory with the instance cap, counting bytes as they
 * arrive (a missing or lying Content-Length cannot get past it), before the form is parsed.
 * Over the cap → 413.
 */
export const capUpload: MiddlewareHandler<Env> = async (c, next) => {
	const cap = await maxUploadBytes(c.var.deps);
	const req = c.req.raw;
	// Multipart framing adds a little; the file itself is checked again after parsing.
	const limit = cap + 64 * 1024;
	if (Number(req.headers.get("content-length") ?? 0) > limit)
		throw tooLarge(cap);
	if (req.body) {
		let seen = 0;
		let over = false;
		const counted = req.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, ctl) {
					seen += chunk.byteLength;
					if (seen > limit) {
						over = true;
						ctl.terminate();
					} else ctl.enqueue(chunk);
				},
			}),
		);
		const buffered = await new Response(counted).arrayBuffer();
		if (over) throw tooLarge(cap);
		// shortcut: the parsed form holds the file in memory (≤ 100 MB by the cap), not a temp file; stream to disk if the cap ever grows.
		c.req.raw = new Request(req.url, {
			method: req.method,
			headers: req.headers,
			body: buffered,
		});
	}
	await next();
};

export const tooLarge = (cap: number) =>
	new Failure(
		"payload_too_large",
		`attachments are limited to ${Math.round(cap / 1024 / 1024)} MB`,
	);

export function toAttachmentDto(
	a: typeof workAttachment.$inferSelect,
): WorkAttachment {
	return {
		id: a.id,
		projectId: a.projectId,
		taskId: a.taskId,
		commentId: a.commentId,
		inlineIn: a.inlineIn,
		uploaderId: a.uploaderId,
		name: a.name,
		contentType: a.contentType,
		size: a.size,
		width: a.width,
		height: a.height,
		url: `/api/work/attachments/${a.id}`,
		thumbUrl: a.thumbKey ? `/api/work/attachments/${a.id}?thumb=1` : null,
		createdAt: a.createdAt.toISOString(),
	};
}
