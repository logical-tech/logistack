import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	project,
	s3Destination,
	workAttachment,
	workBlob,
	workOrgSettings,
} from "@logistack/db";
import type { BackupDestination } from "@logistack/providers";
import { sniffContentType } from "@logistack/worker/work-attachments";
import { migrateBlobs, workGc } from "@logistack/worker/work-blobs";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { parseRange } from "../src/routes/work/attachments.ts";
import { hasDocker } from "./harness.ts";
import { collabFixture } from "./work-collab-fixture.ts";

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe("magic-byte sniffing", () => {
	test.each([
		[
			bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0),
			"x.jpg",
			"image/png",
		],
		[bytes(0xff, 0xd8, 0xff, 0xe0), "x.png", "image/jpeg"],
		[text("GIF89a...."), "x", "image/gif"],
		[text("RIFF\0\0\0\0WEBPVP8 "), "x", "image/webp"],
		[text("%PDF-1.7\n"), "x.txt", "application/pdf"],
		[text("\0\0\0\x18ftypheic"), "x", "image/heic"],
		[text("\0\0\0\x18ftypisom"), "x", "video/mp4"],
		[
			text("PK\x03\x04....word/document.xml"),
			"x.zip",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		],
		[text("PK\x03\x04....data.bin"), "x.docx", "application/zip"],
		[text("a,b\n1,2\n"), "data.csv", "text/csv"],
		[text("hello"), "notes", "text/plain; charset=utf-8"],
		[
			text(
				'<?xml version="1.0"?>\n<!-- hi -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
			),
			"x.png",
			"image/svg+xml",
		],
		[
			text("<html><script>alert(1)</script></html>"),
			"x.html",
			"text/plain; charset=utf-8",
		],
		[bytes(0, 1, 2, 3, 250), "x.png", "application/octet-stream"],
	])("%#: %s", (b, name, type) => {
		expect(sniffContentType(b, name)).toBe(type);
	});

	test("ranges", () => {
		expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
		expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange("bytes=-5", 100)).toEqual({ start: 95, end: 99 });
		expect(parseRange("bytes=200-", 100)).toBeNull();
		expect(parseRange(undefined, 100)).toBeNull();
	});
});

/** In-memory stand-in for an S3 destination. */
function memoryDestination() {
	const objects = new Map<string, Uint8Array>();
	const dest: BackupDestination = {
		probe: async () => {},
		async upload(key, body) {
			objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
		},
		download: (key) =>
			new Response(objects.get(key)).body as ReadableStream<Uint8Array>,
		list: async (prefix = "") =>
			[...objects.keys()]
				.filter((k) => k.startsWith(prefix))
				.map((key) => ({ key, size: 0, lastModified: new Date(0) })),
		delete: async (key) => void objects.delete(key),
	};
	return { dest, objects };
}

describe.skipIf(!hasDocker)("work attachments", () => {
	let f: Awaited<ReturnType<typeof collabFixture>>;

	beforeAll(async () => {
		f = await collabFixture("wcol-at");
	}, 120_000);
	afterAll(() => f?.h.close());

	async function upload(
		as: { headers: Record<string, string> },
		file: Uint8Array | Blob,
		name: string,
		fields: Record<string, string>,
	) {
		const form = new FormData();
		form.set("file", new File([file], name));
		for (const [k, v] of Object.entries(fields)) form.set(k, v);
		const res = await f.h.app.request("/api/work/attachments", {
			method: "POST",
			headers: { origin: f.h.config.WEB_ORIGIN, ...as.headers },
			body: form,
		});
		const body = await res.text();
		return {
			status: res.status,
			json: body.startsWith("{") ? JSON.parse(body) : body,
		};
	}
	const get = (
		as: { headers: Record<string, string> },
		url: string,
		headers = {},
	) => f.h.app.request(url, { headers: { ...as.headers, ...headers } });

	test("permissions: task files need work, comment files comment:work", async () => {
		const t = await f.task("Perm");
		expect(
			(await upload(f.vic.as, text("a"), "a.txt", { taskId: t.id })).status,
		).toBe(403);
		expect(
			(
				await upload(f.vic.as, text("a"), "a.txt", {
					taskId: t.id,
					inline: "comment",
				})
			).status,
		).toBe(201);
		expect(
			(
				await upload(f.ops.as, text("a"), "a.txt", {
					taskId: t.id,
					inline: "comment",
				})
			).status,
		).toBe(403);
		const mine = await upload(f.dev.as, text("dev file"), "d.txt", {
			taskId: t.id,
		});
		expect(mine.status).toBe(201);
		expect((await get(f.ops.as, mine.json.url)).status).toBe(403);
		expect((await f.h.call("DELETE", mine.json.url, f.vic.as)).status).toBe(
			403,
		);
		expect((await f.h.call("DELETE", mine.json.url, f.mia.as)).status).toBe(
			204,
		);
		expect((await get(f.dev.as, mine.json.url)).status).toBe(404);
	});

	test("comment attachments bind to the comment that references them", async () => {
		const t = await f.task("Bind");
		const a = await upload(f.vic.as, text("shot"), "s.txt", {
			taskId: t.id,
			inline: "comment",
		});
		const c = await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
			...f.vic.as,
			body: {
				body: {
					type: "doc",
					content: [
						{ type: "paragraph", content: [{ type: "text", text: "see" }] },
					],
				},
				attachmentIds: [a.json.id],
			},
		});
		expect(c.status).toBe(201);
		expect(c.json.attachments.map((x: { id: string }) => x.id)).toEqual([
			a.json.id,
		]);
		// Someone else's upload cannot be bound.
		const other = await upload(f.dev.as, text("x"), "x.txt", {
			taskId: t.id,
			inline: "comment",
		});
		const refused = await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
			...f.vic.as,
			body: {
				body: {
					type: "doc",
					content: [
						{ type: "paragraph", content: [{ type: "text", text: "x" }] },
					],
				},
				attachmentIds: [other.json.id],
			},
		});
		expect(refused.status).toBe(400);
	});

	test("SVG is stored as SVG but served as a sandboxed download", async () => {
		const t = await f.task("Svg");
		const svg = text(
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
		);
		const up = await upload(f.dev.as, svg, "logo.png", { taskId: t.id });
		expect(up.status).toBe(201);
		expect(up.json).toMatchObject({
			contentType: "image/svg+xml",
			thumbUrl: null,
		});
		const res = await get(f.dev.as, up.json.url);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/svg+xml");
		expect(res.headers.get("content-disposition")).toStartWith("attachment;");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(res.headers.get("content-security-policy")).toContain(
			"default-src 'none'",
		);
		// A PDF is inline.
		const pdf = await upload(f.dev.as, text("%PDF-1.7\n..."), "doc.pdf", {
			taskId: t.id,
		});
		const pdfRes = await get(f.dev.as, pdf.json.url);
		expect(pdfRes.headers.get("content-disposition")).toStartWith("inline;");
	});

	test("images lose EXIF, are rotated and get a WebP thumbnail", async () => {
		const t = await f.task("Exif");
		const jpeg = await sharp({
			create: { width: 1200, height: 600, channels: 3, background: "#3366cc" },
		})
			.jpeg()
			.withExif({ IFD0: { Copyright: "secret place" } })
			.withMetadata({ orientation: 6 })
			.toBuffer();
		expect((await sharp(jpeg).metadata()).exif).toBeDefined();
		const up = await upload(f.dev.as, new Uint8Array(jpeg), "photo.jpg", {
			taskId: t.id,
		});
		expect(up.status).toBe(201);
		// Orientation 6 means rotated 90°: stored upright.
		expect(up.json).toMatchObject({
			contentType: "image/jpeg",
			width: 600,
			height: 1200,
		});
		const stored = new Uint8Array(
			await (await get(f.dev.as, up.json.url)).arrayBuffer(),
		);
		const meta = await sharp(stored).metadata();
		expect(meta.exif).toBeUndefined();
		expect(new TextDecoder("latin1").decode(stored)).not.toContain(
			"secret place",
		);
		const thumb = await get(f.dev.as, up.json.thumbUrl);
		expect(thumb.headers.get("content-type")).toBe("image/webp");
		const tm = await sharp(
			new Uint8Array(await thumb.arrayBuffer()),
		).metadata();
		expect(tm).toMatchObject({ format: "webp", width: 480 });
	});

	test("ETag and Range", async () => {
		const t = await f.task("Range");
		const body = text("0123456789abcdefghij");
		const up = await upload(f.dev.as, body, "r.bin.txt", { taskId: t.id });
		const full = await get(f.dev.as, up.json.url);
		const etag = full.headers.get("etag") as string;
		expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
		expect(
			(await get(f.dev.as, up.json.url, { "if-none-match": etag })).status,
		).toBe(304);
		const part = await get(f.dev.as, up.json.url, { range: "bytes=10-14" });
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe("bytes 10-14/20");
		expect(await part.text()).toBe("abcde");
		expect(
			(await get(f.dev.as, up.json.url, { range: "bytes=50-" })).status,
		).toBe(416);
	});

	test("over the instance cap → 413", async () => {
		const t = await f.task("Cap");
		expect(
			(
				await f.h.call("PATCH", "/api/instance/settings", {
					...f.asOwner,
					body: { workAttachmentMaxMb: 1 },
				})
			).status,
		).toBe(200);
		const big = new Uint8Array(1_200_000).fill(97);
		expect(
			(await upload(f.dev.as, big, "big.txt", { taskId: t.id })).status,
		).toBe(413);
		await f.h.call("PATCH", "/api/instance/settings", {
			...f.asOwner,
			body: { workAttachmentMaxMb: 25 },
		});
		expect(
			(await upload(f.dev.as, big, "big.txt", { taskId: t.id })).status,
		).toBe(201);
	});

	test("over the organization quota → 409 with numbers", async () => {
		const t = await f.task("Quota");
		const [filler] = await f.h.deps.db
			.insert(workAttachment)
			.values({
				projectId: f.projectId,
				taskId: t.id,
				name: "filler",
				contentType: "text/plain",
				size: 2 * 1024 ** 3,
				sha256: "0".repeat(64),
				objectKey: "0".repeat(64),
			})
			.returning();
		const res = await upload(f.dev.as, text("one more"), "x.txt", {
			taskId: t.id,
		});
		expect(res.status).toBe(409);
		expect(res.json.error.details).toMatchObject({
			reason: "quota_exceeded",
			quotaBytes: 2 * 1024 ** 3,
		});
		const s = await f.h.call("GET", "/api/work/attachment-settings", f.mia.as);
		expect(s.json.usedBytes).toBeGreaterThan(2 * 1024 ** 3);
		expect(
			(await f.h.call("GET", "/api/work/attachment-settings", f.dev.as)).status,
		).toBe(403);
		await f.h.deps.db
			.delete(workAttachment)
			.where(eq(workAttachment.id, filler?.id as string));
	});

	test("identical files share one blob; GC drops references and then the blob", async () => {
		const t = await f.task("Dedup");
		const same = text(`dedup ${crypto.randomUUID()}`);
		const a = await upload(f.dev.as, same, "a.txt", { taskId: t.id });
		const b = await upload(f.dev.as, same, "b.txt", { taskId: t.id });
		const sha = new Bun.CryptoHasher("sha256").update(same).digest("hex");
		const blob = () =>
			f.h.deps.db.select().from(workBlob).where(eq(workBlob.sha256, sha));
		expect((await blob())[0]?.refCount).toBe(2);
		await f.h.call("DELETE", a.json.url, f.dev.as);
		const future = new Date(Date.now() + 31 * 86_400_000);
		// Soft-deleted under 30 days ago: kept.
		await workGc(f.h.deps.db, new Date(), async () => null);
		expect((await blob())[0]?.refCount).toBe(2);
		const r1 = await workGc(f.h.deps.db, future, async () => null);
		expect(r1.removed).toBeGreaterThanOrEqual(1);
		expect((await blob())[0]?.refCount).toBe(1);
		await f.h.call("DELETE", b.json.url, f.dev.as);
		await workGc(f.h.deps.db, future, async () => null);
		expect(await blob()).toEqual([]);
	});

	test("deleting tasks releases their blobs (task, subtask and bulk deletes)", async () => {
		const blob = (b: Uint8Array) =>
			f.h.deps.db
				.select()
				.from(workBlob)
				.where(
					eq(
						workBlob.sha256,
						new Bun.CryptoHasher("sha256").update(b).digest("hex"),
					),
				);
		const parent = await f.task("Doomed");
		const sub = await f.task("Doomed sub", { parentId: parent.id });
		const a = text(`parent ${crypto.randomUUID()}`);
		const b = text(`sub ${crypto.randomUUID()}`);
		expect(
			(await upload(f.dev.as, a, "a.txt", { taskId: parent.id })).status,
		).toBe(201);
		expect(
			(await upload(f.dev.as, b, "b.txt", { taskId: sub.id })).status,
		).toBe(201);
		expect((await blob(a))[0]?.refCount).toBe(1);
		const del = await f.h.call(
			"DELETE",
			`/api/work/tasks/${parent.id}`,
			f.mia.as,
		);
		expect(del.status).toBe(204);
		expect(await blob(a)).toEqual([]);
		expect(await blob(b)).toEqual([]);

		const bulk = await f.task("Bulk doomed");
		const c = text(`bulk ${crypto.randomUUID()}`);
		await upload(f.dev.as, c, "c.txt", { taskId: bulk.id });
		const res = await f.h.call("POST", "/api/work/tasks/bulk", {
			...f.mia.as,
			body: { taskIds: [bulk.id], delete: true },
		});
		expect(res.json.errors).toEqual([]);
		expect(await blob(c)).toEqual([]);
	});

	test("migrate-blobs moves database attachments to S3, resumably; GC cleans S3 too", async () => {
		const t = await f.task("Migrate");
		const up = await upload(
			f.dev.as,
			text(`move ${crypto.randomUUID()}`),
			"m.txt",
			{ taskId: t.id },
		);
		const sha = (
			await f.h.deps.db
				.select()
				.from(workAttachment)
				.where(eq(workAttachment.id, up.json.id))
		)[0]?.sha256;
		const { dest, objects } = memoryDestination();
		const moved = await migrateBlobs(f.h.deps.db, f.orgId, dest);
		expect(moved).toBeGreaterThan(0);
		expect(await migrateBlobs(f.h.deps.db, f.orgId, dest)).toBe(0);
		const [row] = await f.h.deps.db
			.select()
			.from(workAttachment)
			.where(eq(workAttachment.id, up.json.id));
		expect(row).toMatchObject({
			driver: "s3",
			objectKey: `work/${f.orgId}/${sha}`,
		});
		expect(objects.has(`work/${f.orgId}/${sha}`)).toBe(true);
		expect(
			await f.h.deps.db
				.select()
				.from(workBlob)
				.where(eq(workBlob.sha256, sha as string)),
		).toEqual([]);
		// An unreferenced object is an orphan; a referenced one stays.
		objects.set(`work/${f.orgId}/orphan`, text("x"));
		await f.h.call("DELETE", up.json.url, f.dev.as);
		await f.h.deps.db
			.insert(workOrgSettings)
			.values({ organizationId: f.orgId })
			.onConflictDoNothing();
		const [d] = await f.h.deps.db
			.insert(s3Destination)
			.values({
				organizationId: f.orgId,
				name: "mem",
				endpoint: "https://s3.example.com",
				region: "us-east-1",
				bucket: "bucket",
				accessKeyId: "a",
				secretEncrypted: "x",
			})
			.returning();
		await f.h.deps.db
			.update(workOrgSettings)
			.set({ attachmentDestinationId: d?.id })
			.where(eq(workOrgSettings.organizationId, f.orgId));
		await workGc(
			f.h.deps.db,
			new Date(Date.now() + 31 * 86_400_000),
			async () => dest,
		);
		expect(objects.has(`work/${f.orgId}/${sha}`)).toBe(false);
		expect(objects.has(`work/${f.orgId}/orphan`)).toBe(false);
		// Every remaining object is still referenced by a live attachment.
		const live = await f.h.deps.db
			.select({ key: workAttachment.objectKey, thumb: workAttachment.thumbKey })
			.from(workAttachment)
			.where(eq(workAttachment.driver, "s3"));
		const referenced = new Set(live.flatMap((l) => [l.key, l.thumb]));
		expect([...objects.keys()].every((k) => referenced.has(k))).toBe(true);
		const projects = await f.h.deps.db
			.select()
			.from(project)
			.where(eq(project.id, f.projectId));
		expect(projects).toHaveLength(1);
	});

	test("migration endpoint needs a destination", async () => {
		await f.h.deps.db
			.update(workOrgSettings)
			.set({ attachmentDestinationId: null })
			.where(eq(workOrgSettings.organizationId, f.orgId));
		expect(
			(
				await f.h.call(
					"POST",
					"/api/work/attachment-settings/migrate",
					f.mia.as,
				)
			).status,
		).toBe(409);
		expect(
			(
				await f.h.call("PUT", "/api/work/attachment-settings", {
					...f.mia.as,
					body: { destinationId: "s3d_missing" },
				})
			).status,
		).toBe(404);
	});
});
