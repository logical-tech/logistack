import type { WorkNotificationKind } from "@logistack/contracts";
import { addDays, verifyUnsubscribe, zonedMidnight } from "@logistack/core";
import {
	workProject,
	workStatus,
	workTask,
	workTaskAssignee,
	workUserPrefs,
} from "@logistack/db";
import { taskUrl, workBaseUrl } from "@logistack/worker/work-mail";
import { and, eq, gte, isNotNull, isNull, notInArray } from "drizzle-orm";
import { Hono } from "hono";
import { clientIp } from "../../audit.ts";
import type { Env } from "../../env.ts";
import { overLimit } from "../../rate-limit.ts";
import { locate } from "../../scope.ts";
import { memberAccess } from "../../work/notify.ts";
import { DEFAULT_KINDS, icalHash } from "./inbox.ts";

/**
 * Public, unauthenticated Work endpoints outside /api, like status pages: the calendar feed
 * (`/ical/<token>.ics`, plan 12.12) and email unsubscribe links (plan 14.3). The token in the
 * path is the credential.
 */

/** RFC 5545 text: escape, then fold lines at 75 octets. */
const icsText = (s: string) =>
	s
		.replace(/\\/g, "\\\\")
		.replace(/\r\n?|\n/g, "\\n")
		.replace(/[,;]/g, (m) => `\\${m}`);

function fold(line: string) {
	const bytes = new TextEncoder().encode(line);
	if (bytes.length <= 75) return line;
	const out: string[] = [];
	let cur = "";
	let len = 0;
	for (const ch of line) {
		const n = new TextEncoder().encode(ch).length;
		if (len + n > (out.length ? 74 : 75)) {
			out.push(cur);
			cur = "";
			len = 0;
		}
		cur += ch;
		len += n;
	}
	out.push(cur);
	return out.join("\r\n ");
}

const icsDate = (d: string) => d.replaceAll("-", "");
const icsStamp = (d: Date) =>
	d
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");

export type IcalEvent = {
	id: string;
	summary: string;
	url: string;
	dueDate: string;
	/** `HH:MM[:SS]` local to `tz`; null: an all-day event. */
	dueTime: string | null;
	tz: string;
};

export function renderIcal(events: IcalEvent[], now: Date): string {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//LogiStack//Work//EN",
		"CALSCALE:GREGORIAN",
		"X-WR-CALNAME:LogiStack tasks",
	];
	for (const e of events) {
		lines.push(
			"BEGIN:VEVENT",
			`UID:${e.id}@logistack`,
			`DTSTAMP:${icsStamp(now)}`,
		);
		if (e.dueTime) {
			const [h = 0, m = 0] = e.dueTime.split(":").map(Number);
			const at = new Date(
				zonedMidnight(e.dueDate, e.tz).getTime() + (h * 60 + m) * 60_000,
			);
			lines.push(
				`DTSTART:${icsStamp(at)}`,
				`DTEND:${icsStamp(new Date(at.getTime() + 30 * 60_000))}`,
			);
		} else
			lines.push(
				`DTSTART;VALUE=DATE:${icsDate(e.dueDate)}`,
				`DTEND;VALUE=DATE:${icsDate(addDays(e.dueDate, 1))}`,
			);
		lines.push(
			`SUMMARY:${icsText(e.summary)}`,
			`URL:${e.url}`,
			`DESCRIPTION:${icsText(e.url)}`,
			"END:VEVENT",
		);
	}
	lines.push("END:VCALENDAR");
	return `${lines.map(fold).join("\r\n")}\r\n`;
}

const page = (title: string, body: string) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;color:#171717}button{font:inherit;padding:8px 14px;border-radius:6px;border:0;background:#171717;color:#fff;cursor:pointer}@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#ededed}button{background:#ededed;color:#0a0a0a}}</style></head><body>${body}</body></html>`;

const KIND_LABEL: Record<WorkNotificationKind | "digest", string> = {
	assigned: "assignments",
	unassigned: "unassignments",
	mentioned: "mentions",
	commented: "comments",
	replied: "replies",
	status_changed: "status changes",
	due_soon: "due-soon reminders",
	overdue: "overdue reminders",
	checklist_assigned: "checklist assignments",
	timer_running_long: "running timer reminders",
	digest: "the daily digest",
};

/** Per client and per token: a calendar app polls every few minutes, a scraper does not get far. */
const ICAL_PER_MINUTE = 30;

export const workPublic = new Hono<Env>()
	.get("/ical/:file", async (c) => {
		const { deps } = c.var;
		const file = c.req.param("file");
		if (!file.endsWith(".ics")) return c.text("not found", 404);
		const token = file.slice(0, -4);
		for (const bucket of [
			`ical:${clientIp(c) ?? "unknown"}`,
			`ical:t:${icalHash(token).slice(0, 16)}`,
		]) {
			const wait = await overLimit(
				deps.config.REDIS_URL,
				bucket,
				ICAL_PER_MINUTE,
			);
			if (wait !== undefined)
				return c.text("too many requests", 429, {
					"retry-after": String(wait),
				});
		}
		const [p] = await deps.db
			.select()
			.from(workUserPrefs)
			.where(eq(workUserPrefs.icalTokenHash, icalHash(token)));
		if (!p) return c.text("not found", 404);
		const since = addDays(new Date().toISOString().slice(0, 10), -90);
		const rows = await deps.db
			.select({
				id: workTask.id,
				projectId: workTask.projectId,
				number: workTask.number,
				title: workTask.title,
				dueDate: workTask.dueDate,
				dueTime: workTask.dueTime,
				key: workProject.key,
				organizationId: workProject.organizationId,
			})
			.from(workTask)
			.innerJoin(workTaskAssignee, eq(workTaskAssignee.taskId, workTask.id))
			.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
			.innerJoin(workStatus, eq(workStatus.id, workTask.statusId))
			.where(
				and(
					eq(workTaskAssignee.userId, p.userId),
					eq(workProject.organizationId, p.organizationId),
					isNull(workTask.archivedAt),
					isNotNull(workTask.dueDate),
					gte(workTask.dueDate, since),
					notInArray(workStatus.category, ["done", "cancelled"]),
				),
			)
			.limit(2000);
		const access = memberAccess(deps, p.organizationId);
		const allowed = new Map<string, boolean>();
		for (const projectId of new Set(rows.map((r) => r.projectId))) {
			const resource = await locate(
				deps.db,
				p.organizationId,
				"project",
				projectId,
			).catch(() => null);
			allowed.set(
				projectId,
				!!resource && (await access(p.userId, "read:work", resource)),
			);
		}
		const base = await workBaseUrl(deps.db, deps.config.WEB_ORIGIN);
		const body = renderIcal(
			rows
				.filter((r) => allowed.get(r.projectId))
				.map((r) => ({
					id: r.id,
					summary: `${r.key}-${r.number} ${r.title}`,
					url: taskUrl(base, r.key, r.number),
					dueDate: r.dueDate as string,
					dueTime: r.dueTime,
					tz: p.timezone ?? "UTC",
				})),
			new Date(),
		);
		return c.body(body, 200, {
			"content-type": "text/calendar; charset=utf-8",
			"cache-control": "private, max-age=300",
			"x-content-type-options": "nosniff",
		});
	})
	.get("/mail/unsubscribe/:token", async (c) => {
		const claim = await verifyUnsubscribe(
			c.req.param("token"),
			c.var.deps.config.LOGISTACK_MASTER_KEY,
		);
		if (!claim)
			return c.html(
				page("Invalid link", "<p>This link is not valid.</p>"),
				404,
			);
		const what = KIND_LABEL[claim.kind] ?? "these emails";
		return c.html(
			page(
				"Unsubscribe",
				`<p>Stop emails about ${what}?</p><form method="post"><button type="submit">Unsubscribe</button></form>`,
			),
		);
	})
	.post("/mail/unsubscribe/:token", async (c) => {
		const { deps } = c.var;
		const claim = await verifyUnsubscribe(
			c.req.param("token"),
			deps.config.LOGISTACK_MASTER_KEY,
		);
		if (!claim)
			return c.html(
				page("Invalid link", "<p>This link is not valid.</p>"),
				404,
			);
		await unsubscribe(deps.db, claim);
		return c.html(
			page(
				"Unsubscribed",
				`<p>You will not get emails about ${KIND_LABEL[claim.kind] ?? "this"} anymore. Change this any time in Account → Notifications.</p>`,
			),
		);
	});

export async function unsubscribe(
	db: Env["Variables"]["deps"]["db"],
	claim: {
		userId: string;
		organizationId: string;
		kind: WorkNotificationKind | "digest";
	},
) {
	const [p] = await db
		.select({ kinds: workUserPrefs.emailKinds })
		.from(workUserPrefs)
		.where(
			and(
				eq(workUserPrefs.userId, claim.userId),
				eq(workUserPrefs.organizationId, claim.organizationId),
			),
		);
	const set =
		claim.kind === "digest"
			? { email: "off" as const }
			: {
					emailKinds: (p?.kinds ?? DEFAULT_KINDS).filter(
						(k) => k !== claim.kind,
					),
				};
	await db
		.insert(workUserPrefs)
		.values({
			userId: claim.userId,
			organizationId: claim.organizationId,
			...set,
		})
		.onConflictDoUpdate({
			target: [workUserPrefs.userId, workUserPrefs.organizationId],
			set: { ...set, updatedAt: new Date() },
		})
		// The user may have left the organization since; the link then does nothing.
		.catch(() => {});
}
