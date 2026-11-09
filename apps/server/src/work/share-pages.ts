import type { PmDoc, WorkColor, WorkFieldConfig } from "@logistack/contracts";
import { docToEmailHtml, formatFieldValue, matchesTask } from "@logistack/core";
import {
	type Db,
	project,
	user,
	workAttachment,
	workChecklistItem,
	workComment,
	workField,
	workFieldValue,
	workList,
	workProject,
	workShare,
	workStatus,
	workTask,
	workTaskAssignee,
	workTaskTag,
	workView,
} from "@logistack/db";
import { hmacSha256, safeEqual, sha256Hex } from "@logistack/providers";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { clientIp } from "../audit.ts";
import type { Env } from "../env.ts";
import { overLimit } from "../rate-limit.ts";
import { escapeHtml as esc } from "../status-render.ts";
import { storeFor } from "./blob-store.ts";

/**
 * Read-only share links (plan 12.7): server-rendered pages at `/share/<token>` with no client JS,
 * like the public status pages. Only what the link allows leaves the server.
 */

type Share = typeof workShare.$inferSelect;

export const SHARE_COOKIE_HOURS = 12;
const PAGES_PER_MINUTE = 120;
const PASSWORDS_PER_MINUTE = 10;

/** sha256 of the token; only the hash is stored. */
export const shareTokenHash = (token: string) => sha256Hex(token);

/** A fresh 32-byte token, base64url. */
export const newShareToken = () =>
	crypto
		.getRandomValues(new Uint8Array(32))
		.toBase64({ alphabet: "base64url", omitPadding: true });

async function findShare(db: Db, token: string): Promise<Share | undefined> {
	if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
	const [row] = await db
		.select({ share: workShare, allowed: workProject.allowShareLinks })
		.from(workShare)
		.innerJoin(workProject, eq(workProject.projectId, workShare.projectId))
		.where(eq(workShare.tokenHash, await shareTokenHash(token)));
	if (!row?.allowed || row.share.revokedAt) return undefined;
	if (row.share.expiresAt && row.share.expiresAt <= new Date())
		return undefined;
	return row.share;
}

// Password cookie: `<expiry ms>.<hex HMAC(k, shareId.expiry.passwordHash)>`, scoped to the share's path.
// k is derived from the auth secret for this use only; the password hash makes a new password end old cookies.
const cookieName = (shareId: string) => `ls_share_${shareId}`;
const cookieMac = async (secret: string, share: Share, exp: number) =>
	hmacSha256(
		await hmacSha256(secret, "logistack/work-share-cookie/v1"),
		`${share.id}.${exp}.${share.passwordHash ?? ""}`,
	).then((b) => b.toHex());

async function unlocked(c: Context<Env>, share: Share) {
	if (!share.passwordHash) return true;
	const raw = getCookie(c, cookieName(share.id));
	const [exp, mac] = raw?.split(".") ?? [];
	if (!exp || !mac || Number(exp) < Date.now()) return false;
	const want = await cookieMac(
		c.var.deps.config.BETTER_AUTH_SECRET,
		share,
		Number(exp),
	);
	return safeEqual(mac, want);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type ShareTask = {
	id: string;
	number: number;
	title: string;
	statusId: string;
	priority: string;
	startDate: string | null;
	dueDate: string | null;
	assignees: string[];
	fields: { name: string; value: string }[];
};

type ShareData = {
	title: string;
	key: string;
	board: boolean;
	statuses: { id: string; name: string; color: WorkColor; category: string }[];
	tasks: ShareTask[];
};

/** Top-level tasks the share shows: its list, or its view's list and filter. */
async function loadShare(db: Db, share: Share): Promise<ShareData> {
	const [view] = share.viewId
		? await db.select().from(workView).where(eq(workView.id, share.viewId))
		: [];
	const listId = share.listId ?? view?.listId ?? null;
	const [[wp], [list], statuses] = await Promise.all([
		db
			.select({ key: workProject.key })
			.from(workProject)
			.where(eq(workProject.projectId, share.projectId)),
		listId
			? db
					.select({ name: workList.name })
					.from(workList)
					.where(eq(workList.id, listId))
			: Promise.resolve([]),
		db
			.select({
				id: workStatus.id,
				name: workStatus.name,
				color: workStatus.color,
				category: workStatus.category,
			})
			.from(workStatus)
			.where(eq(workStatus.projectId, share.projectId))
			.orderBy(asc(workStatus.position)),
	]);
	const rows = await db
		.select({ task: workTask })
		.from(workTask)
		.innerJoin(workList, eq(workList.id, workTask.listId))
		.where(
			and(
				eq(workTask.projectId, share.projectId),
				isNull(workTask.archivedAt),
				isNull(workTask.parentId),
				isNull(workList.archivedAt),
				listId ? eq(workTask.listId, listId) : undefined,
			),
		)
		.orderBy(asc(workTask.position));
	const ids = rows.map((r) => r.task.id);
	const [assignees, tags, values, fields] = ids.length
		? await Promise.all([
				db
					.select({
						taskId: workTaskAssignee.taskId,
						userId: workTaskAssignee.userId,
						name: user.name,
					})
					.from(workTaskAssignee)
					.innerJoin(user, eq(user.id, workTaskAssignee.userId))
					.where(inArray(workTaskAssignee.taskId, ids)),
				db.select().from(workTaskTag).where(inArray(workTaskTag.taskId, ids)),
				db
					.select()
					.from(workFieldValue)
					.where(inArray(workFieldValue.taskId, ids)),
				db
					.select()
					.from(workField)
					.where(eq(workField.projectId, share.projectId)),
			])
		: [[], [], [], []];
	const category = new Map(statuses.map((s) => [s.id, s.category]));
	const fieldById = new Map(fields.map((f) => [f.id, f]));
	const userNames = Object.fromEntries(
		assignees.map((a) => [a.userId, a.name]),
	);
	const by = <T extends { taskId: string }>(xs: T[], id: string) =>
		xs.filter((x) => x.taskId === id);
	const config = view?.config;
	const tasks = rows.flatMap(({ task: t }) => {
		const taskValues = by(values, t.id);
		if (config) {
			if (
				!config.showClosed &&
				["done", "cancelled"].includes(category.get(t.statusId) ?? "")
			)
				return [];
			if (
				config.filter &&
				!matchesTask(
					config.filter,
					{
						...t,
						statusCategory: category.get(t.statusId) ?? "",
						assigneeIds: by(assignees, t.id).map((a) => a.userId),
						tagIds: by(tags, t.id).map((x) => x.tagId),
						// shortcut: dependencies aren't loaded, so a "blocked" filter treats every task as unblocked.
						blocked: false,
						fields: Object.fromEntries(
							taskValues.map((v) => [v.fieldId, v.value]),
						),
					},
					{ me: "", now: new Date() },
				)
			)
				return [];
		}
		return [
			{
				id: t.id,
				number: t.number,
				title: t.title,
				statusId: t.statusId,
				priority: t.priority,
				startDate: t.startDate,
				dueDate: t.dueDate,
				assignees: share.showAssignees
					? by(assignees, t.id).map((a) => a.name)
					: [],
				fields: share.fieldIds.flatMap((fid) => {
					const f = fieldById.get(fid);
					const v = taskValues.find((x) => x.fieldId === fid);
					if (!f || !v) return [];
					const value = formatFieldValue(
						{ config: f.config as WorkFieldConfig },
						v.value,
						"en",
						userNames,
					);
					return value ? [{ name: f.name, value }] : [];
				}),
			},
		];
	});
	return {
		title: view?.name ?? list?.name ?? "Tasks",
		key: wp?.key ?? "",
		board: view?.kind === "board",
		statuses,
		tasks,
	};
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const COLORS: Record<WorkColor, string> = {
	gray: "#87909f",
	blue: "#3b82f6",
	amber: "#f59e0b",
	green: "#22c55e",
	red: "#ef4444",
	violet: "#8b5cf6",
	pink: "#ec4899",
	teal: "#14b8a6",
};

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#0b0b0c;--muted:#6b6f76;--line:#ececee;--card:#fafafa}
@media(prefers-color-scheme:dark){:root{--bg:#0b0b0c;--fg:#ededef;--muted:#8d9098;--line:#222326;--card:#131315}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:960px;margin:0 auto;padding:48px 20px 64px}h1{font-size:22px;font-weight:600;letter-spacing:-.01em;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 32px}h2{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:28px 0 8px;display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}.count{font-variant-numeric:tabular-nums;font-weight:500}
table{width:100%;border-collapse:collapse}td{padding:9px 8px;border-top:1px solid var(--line);vertical-align:top}td.k{width:88px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
td.m{color:var(--muted);text-align:right;white-space:nowrap}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}
.meta{color:var(--muted);font-size:13px}.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(220px,1fr);gap:12px;overflow-x:auto;padding-bottom:8px}
.col h2{margin-top:0}.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px}
.card .meta{display:block;margin-top:4px}dl{display:grid;grid-template-columns:140px 1fr;gap:6px 16px;margin:0 0 24px}dt{color:var(--muted)}dd{margin:0}
.doc{border-top:1px solid var(--line);padding-top:16px}.doc img{max-width:100%;border-radius:8px}.doc pre{background:var(--card);padding:12px;border-radius:8px;overflow-x:auto}
.comment{border-top:1px solid var(--line);padding:12px 0}.comment .meta{margin-bottom:4px}.back{display:inline-block;margin-bottom:24px;color:var(--muted)}
form{display:flex;gap:8px;max-width:360px}input{flex:1;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
button{font:inherit;padding:8px 14px;border:0;border-radius:8px;background:var(--fg);color:var(--bg);cursor:pointer}.err{color:#ef4444;margin-top:8px}
footer{margin-top:48px;color:var(--muted);font-size:12px}`;

function page(title: string, body: string) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}<footer>Shared read-only with LogiStack</footer></main></body></html>`;
}

const fmtDate = (d: string | null) =>
	d
		? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
				day: "numeric",
				month: "short",
				timeZone: "UTC",
			})
		: "";

function taskMeta(t: ShareTask) {
	const parts = [
		t.dueDate ? `Due ${fmtDate(t.dueDate)}` : "",
		t.assignees.join(", "),
		...t.fields.map((f) => `${f.name}: ${f.value}`),
	].filter(Boolean);
	return esc(parts.join(" · "));
}

export function renderSharePage(d: ShareData, base: string): string {
	const groups = d.statuses
		.map((s) => ({ s, tasks: d.tasks.filter((t) => t.statusId === s.id) }))
		.filter((g) => g.tasks.length);
	const head = (s: ShareData["statuses"][number], n: number) =>
		`<h2><span class="dot" style="background:${COLORS[s.color] ?? COLORS.gray}"></span>${esc(s.name)} <span class="count">${n}</span></h2>`;
	const link = (t: ShareTask) => `${base}/t/${t.number}`;
	const body = d.board
		? `<div class="board">${groups
				.map(
					(g) =>
						`<section class="col">${head(g.s, g.tasks.length)}${g.tasks
							.map(
								(t) =>
									`<a class="card" href="${link(t)}">${esc(t.title)}<span class="meta">${esc(d.key)}-${t.number}${taskMeta(t) ? ` · ${taskMeta(t)}` : ""}</span></a>`,
							)
							.join("")}</section>`,
				)
				.join("")}</div>`
		: groups
				.map(
					(g) =>
						`<section>${head(g.s, g.tasks.length)}<table>${g.tasks
							.map(
								(t) =>
									`<tr><td class="k">${esc(d.key)}-${t.number}</td><td><a href="${link(t)}">${esc(t.title)}</a></td><td class="m meta">${taskMeta(t)}</td></tr>`,
							)
							.join("")}</table></section>`,
				)
				.join("");
	const total = d.tasks.length;
	return page(
		d.title,
		`<h1>${esc(d.title)}</h1><p class="sub">${total} ${total === 1 ? "task" : "tasks"}</p>${body || `<p class="sub">Nothing here yet.</p>`}`,
	);
}

/** Rich text with attachment images pointed at the share's attachment route. */
const richHtml = (doc: PmDoc | null, base: string) =>
	doc
		? docToEmailHtml(doc).replaceAll("/api/work/attachments/", `${base}/a/`)
		: "";

export function renderPasswordPage(title: string, error: boolean) {
	return page(
		title,
		`<h1>This link is protected</h1><p class="sub">Enter the password you were given.</p><form method="post"><input type="password" name="password" autocomplete="current-password" aria-label="Password" required autofocus><button type="submit">Open</button></form>${error ? `<p class="err" role="alert">Wrong password.</p>` : ""}`,
	);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function secure(c: Context<Env>) {
	c.header("x-robots-tag", "noindex, nofollow");
	c.header("referrer-policy", "no-referrer");
	c.header("cache-control", "private, no-store");
	c.header("x-content-type-options", "nosniff");
	c.header(
		"content-security-policy",
		"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	);
}

async function limited(c: Context<Env>, bucket: string, perMinute: number) {
	const wait = await overLimit(
		c.var.deps.config.REDIS_URL,
		`${bucket}:${clientIp(c) ?? "unknown"}`,
		perMinute,
	);
	if (wait === undefined) return false;
	c.header("retry-after", String(wait));
	return true;
}

const gone = (c: Context<Env>) =>
	c.html(
		page(
			"Link unavailable",
			'<h1>This link is no longer available</h1><p class="sub">Ask whoever shared it for a new one.</p>',
		),
		404,
	);

/** Resolves the share for a request, applying rate limits and the password gate. */
async function gate(c: Context<Env>): Promise<Share | Response> {
	secure(c);
	if (await limited(c, "share", PAGES_PER_MINUTE))
		return c.text("too many requests", 429);
	const share = await findShare(c.var.deps.db, c.req.param("token") ?? "");
	if (!share) return gone(c);
	if (!(await unlocked(c, share)))
		return c.html(renderPasswordPage(share.name, false), 401);
	return share;
}

/** `/share/<token>`, `/share/<token>/t/<number>`, `/share/<token>/a/<attachmentId>`. */
export const sharePages = new Hono<Env>();

sharePages.get("/:token", async (c) => {
	const share = await gate(c);
	if (share instanceof Response) return share;
	const { db } = c.var.deps;
	await db
		.update(workShare)
		.set({
			viewCount: sql`${workShare.viewCount} + 1`,
			lastViewedAt: new Date(),
		})
		.where(eq(workShare.id, share.id));
	return c.html(
		renderSharePage(
			await loadShare(db, share),
			`/share/${c.req.param("token")}`,
		),
	);
});

sharePages.post("/:token", async (c) => {
	secure(c);
	if (await limited(c, "share-password", PASSWORDS_PER_MINUTE))
		return c.text("too many attempts", 429);
	const token = c.req.param("token");
	const share = await findShare(c.var.deps.db, token);
	if (!share) return gone(c);
	if (!share.passwordHash) return c.redirect(`/share/${token}`, 303);
	const form = await c.req.parseBody();
	const password = typeof form.password === "string" ? form.password : "";
	if (!password || !(await Bun.password.verify(password, share.passwordHash)))
		return c.html(renderPasswordPage(share.name, true), 401);
	const exp = Date.now() + SHARE_COOKIE_HOURS * 3_600_000;
	setCookie(
		c,
		cookieName(share.id),
		`${exp}.${await cookieMac(c.var.deps.config.BETTER_AUTH_SECRET, share, exp)}`,
		{
			path: `/share/${token}`,
			httpOnly: true,
			sameSite: "Lax",
			secure: new URL(c.req.url).protocol === "https:",
			maxAge: SHARE_COOKIE_HOURS * 3600,
		},
	);
	return c.redirect(`/share/${token}`, 303);
});

sharePages.get("/:token/t/:number", async (c) => {
	const share = await gate(c);
	if (share instanceof Response) return share;
	const { db } = c.var.deps;
	const base = `/share/${c.req.param("token")}`;
	const data = await loadShare(db, share);
	const t = data.tasks.find((x) => x.number === Number(c.req.param("number")));
	if (!t) return c.html(page("Not found", "<h1>Task not found</h1>"), 404);
	const [[row], checklist, attachments, comments] = await Promise.all([
		db
			.select({ description: workTask.description })
			.from(workTask)
			.where(eq(workTask.id, t.id)),
		db
			.select({ done: workChecklistItem.done })
			.from(workChecklistItem)
			.where(eq(workChecklistItem.taskId, t.id)),
		db
			.select({ id: workAttachment.id, name: workAttachment.name })
			.from(workAttachment)
			.where(
				and(
					eq(workAttachment.taskId, t.id),
					isNull(workAttachment.deletedAt),
					isNull(workAttachment.commentId),
					eq(workAttachment.inlineIn, "none"),
				),
			),
		share.showComments
			? db
					.select({
						body: workComment.body,
						createdAt: workComment.createdAt,
						author: user.name,
					})
					.from(workComment)
					.leftJoin(user, eq(user.id, workComment.authorId))
					.where(
						and(eq(workComment.taskId, t.id), isNull(workComment.deletedAt)),
					)
					.orderBy(asc(workComment.createdAt))
			: Promise.resolve([]),
	]);
	const status = data.statuses.find((s) => s.id === t.statusId);
	const facts: [string, string][] = [
		["Status", status?.name ?? ""],
		["Due", fmtDate(t.dueDate)],
		["Start", fmtDate(t.startDate)],
		["Assignees", t.assignees.join(", ")],
		[
			"Checklist",
			checklist.length
				? `${checklist.filter((i) => i.done).length} of ${checklist.length} done`
				: "",
		],
		...t.fields.map((f): [string, string] => [f.name, f.value]),
	];
	const dl = facts
		.filter(([, v]) => v)
		.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
		.join("");
	const files = attachments.length
		? `<h2>Attachments</h2><ul>${attachments.map((a) => `<li><a href="${base}/a/${esc(a.id)}">${esc(a.name)}</a></li>`).join("")}</ul>`
		: "";
	const thread = comments.length
		? `<h2>Comments</h2>${comments
				.map(
					(cm) =>
						`<div class="comment"><div class="meta">${esc(cm.author ?? "Former member")} · ${cm.createdAt.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</div>${richHtml(cm.body, base)}</div>`,
				)
				.join("")}`
		: "";
	return c.html(
		page(
			t.title,
			`<a class="back" href="${base}">← ${esc(data.title)}</a><h1>${esc(t.title)}</h1><p class="sub">${esc(data.key)}-${t.number}</p><dl>${dl}</dl>${row?.description ? `<div class="doc">${richHtml(row.description, base)}</div>` : ""}${files}${thread}`,
		),
	);
});

const INLINE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

sharePages.get("/:token/a/:attachmentId", async (c) => {
	const share = await gate(c);
	if (share instanceof Response) return share;
	const { db } = c.var.deps;
	const [a] = await db
		.select({
			taskId: workAttachment.taskId,
			commentTaskId: workComment.taskId,
			name: workAttachment.name,
			contentType: workAttachment.contentType,
			driver: workAttachment.driver,
			objectKey: workAttachment.objectKey,
			organizationId: project.organizationId,
		})
		.from(workAttachment)
		.innerJoin(project, eq(project.id, workAttachment.projectId))
		.leftJoin(workComment, eq(workComment.id, workAttachment.commentId))
		.where(
			and(
				eq(workAttachment.id, c.req.param("attachmentId")),
				eq(workAttachment.projectId, share.projectId),
				isNull(workAttachment.deletedAt),
			),
		);
	const taskId = a?.commentTaskId ?? a?.taskId;
	const visible =
		a &&
		taskId &&
		(!a.commentTaskId || share.showComments) &&
		(await loadShare(db, share)).tasks.some((t) => t.id === taskId);
	if (!visible) return c.text("not found", 404);
	const body = await storeFor(c.var.deps, a.organizationId, a.driver)
		.then((store) => store.read(a.objectKey))
		.catch(() => null);
	if (!body) return c.text("not found", 404);
	const inline = INLINE_TYPES.has(a.contentType);
	c.header("content-type", inline ? a.contentType : "application/octet-stream");
	c.header(
		"content-disposition",
		`${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
	);
	c.header("content-security-policy", "default-src 'none'; sandbox");
	return c.body(body);
});
