import type { WorkAttachment } from "@logistack/contracts";
import { instanceSettings, type workAttachment } from "@logistack/db";
import { attachmentQuota } from "@logistack/worker/work-attachments";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Deps, Env } from "../env.ts";
import { Failure } from "../errors.ts";

/** Upload route helpers (plan 10.1): cap and quota; the pipeline itself is shared with the worker. */

export const DEFAULT_MAX_MB = 25;
export const MAX_MB = 100;
export async function maxUploadBytes(deps: Deps) {
	const [s] = await deps.db
		.select({ mb: instanceSettings.workAttachmentMaxMb })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return Math.min(s?.mb ?? DEFAULT_MAX_MB, MAX_MB) * 1024 * 1024;
}

/** Used bytes and the effective quota (null: unlimited) of an organization. */
export const quotaOf = (deps: Deps, organizationId: string) =>
	attachmentQuota(deps.db, organizationId);

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
