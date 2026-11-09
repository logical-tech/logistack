import type { PmDoc, WorkNotificationKind } from "@logistack/contracts";
import { docToEmailHtml } from "./richtext.ts";

/** Notification and digest emails (plan 14.3): plain text plus simple escaped HTML. No I/O. */

export type RenderedEmail = { subject: string; text: string; html: string };

const esc = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const SENTENCE: Record<WorkNotificationKind, string> = {
	assigned: "assigned you to",
	unassigned: "unassigned you from",
	mentioned: "mentioned you on",
	commented: "commented on",
	replied: "replied to you on",
	status_changed: "changed the status of",
	due_soon: "is due soon:",
	overdue: "is overdue:",
	checklist_assigned: "assigned you a checklist item on",
	timer_running_long: "has a timer running for a long time:",
};

function layout(body: string, footer: string) {
	return `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#171717"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:24px">${body}</div><p style="max-width:560px;margin:12px auto 0;color:#737373;font-size:12px">${footer}</p></body></html>`;
}

export type NotificationEmailInput = {
	kind: WorkNotificationKind;
	/** Null: the change was made by LogiStack itself (due dates). */
	actorName: string | null;
	taskKey: string;
	taskTitle: string;
	projectName: string;
	taskUrl: string;
	/** Bundled notifications: how many changes this one stands for. */
	count?: number;
	comment?: PmDoc | null;
	/** Prefix for relative attachment URLs in the comment. */
	baseUrl?: string;
	unsubscribeUrl: string;
};

export function renderNotificationEmail(
	n: NotificationEmailInput,
): RenderedEmail {
	const ref = `${n.taskKey} ${n.taskTitle}`;
	const self = n.kind === "due_soon" || n.kind === "overdue";
	const who = n.actorName ?? "Someone";
	const line =
		(n.count ?? 1) > 1
			? `${who} changed ${n.count} things on ${ref}`
			: self
				? `${ref} ${SENTENCE[n.kind].replace(/:$/, "")}`
				: `${who} ${SENTENCE[n.kind]} ${ref}`;
	const subject = `[${n.projectName}] ${line}`;
	const quote = n.comment ? docToEmailHtml(n.comment, n.baseUrl) : "";
	const footer = `You get this email because of your notification settings. <a href="${esc(n.unsubscribeUrl)}" style="color:#737373">Stop emails like this</a>.`;
	const html = layout(
		`<p style="margin:0 0 16px">${esc(line)}</p>${
			quote
				? `<div style="border-left:3px solid #e5e5e5;padding-left:12px;margin:0 0 16px">${quote}</div>`
				: ""
		}<a href="${esc(n.taskUrl)}" style="display:inline-block;background:#171717;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px">Open ${esc(n.taskKey)}</a>`,
		footer,
	);
	const text = [
		line,
		"",
		...(n.comment ? [plainQuote(n.comment), ""] : []),
		n.taskUrl,
		"",
		`Stop emails like this: ${n.unsubscribeUrl}`,
	].join("\n");
	return { subject, text, html };
}

function plainQuote(doc: PmDoc) {
	// The email HTML renderer already escapes; for text, strip its tags back out.
	return docToEmailHtml(doc)
		.replace(/<br>|<\/(p|li|h2|h3|blockquote|pre)>/g, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.trim()
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
}

export type DigestItem = {
	taskKey: string;
	taskTitle: string;
	projectName: string;
	url: string;
};

export type DigestInput = {
	/** The user's local date, `YYYY-MM-DD`. */
	date: string;
	dueToday: DigestItem[];
	overdue: DigestItem[];
	assigned: DigestItem[];
	mentions: DigestItem[];
	settingsUrl: string;
	unsubscribeUrl: string;
};

/** Null when there is nothing to say (the digest is skipped). */
export function renderDigestEmail(d: DigestInput): RenderedEmail | null {
	const sections = [
		["Due today", d.dueToday],
		["Overdue", d.overdue],
		["Assigned to you", d.assigned],
		["Mentions", d.mentions],
	] as const;
	const total = sections.reduce((n, [, items]) => n + items.length, 0);
	if (total === 0) return null;
	const subject = `Your tasks for ${d.date}: ${sections
		.filter(([, items]) => items.length)
		.map(([title, items]) => `${items.length} ${title.toLowerCase()}`)
		.join(", ")}`;
	const html = layout(
		sections
			.filter(([, items]) => items.length)
			.map(
				([title, items]) =>
					`<h2 style="font-size:14px;margin:0 0 8px">${title}</h2><ul style="margin:0 0 16px;padding-left:18px">${items
						.map(
							(i) =>
								`<li><a href="${esc(i.url)}" style="color:#171717">${esc(i.taskKey)} ${esc(i.taskTitle)}</a> <span style="color:#737373">${esc(i.projectName)}</span></li>`,
						)
						.join("")}</ul>`,
			)
			.join(""),
		`<a href="${esc(d.settingsUrl)}" style="color:#737373">Notification settings</a> · <a href="${esc(d.unsubscribeUrl)}" style="color:#737373">Stop the daily digest</a>`,
	);
	const text = [
		subject,
		"",
		...sections
			.filter(([, items]) => items.length)
			.flatMap(([title, items]) => [
				title,
				...items.map(
					(i) => `- ${i.taskKey} ${i.taskTitle} (${i.projectName}) ${i.url}`,
				),
				"",
			]),
		`Notification settings: ${d.settingsUrl}`,
		`Stop the daily digest: ${d.unsubscribeUrl}`,
	].join("\n");
	return { subject, text, html };
}

// Unsubscribe tokens: `<payload>.<hmac>`, both base64url. `kind` "digest" turns email off.

export type UnsubscribeClaim = {
	userId: string;
	organizationId: string;
	kind: WorkNotificationKind | "digest";
};

const b64 = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
const unb64 = (s: string) =>
	Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
		c.charCodeAt(0),
	);

const hmacKey = (secret: string) =>
	crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(`work-unsubscribe:${secret}`),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);

export async function signUnsubscribe(
	claim: UnsubscribeClaim,
	secret: string,
): Promise<string> {
	const payload = new TextEncoder().encode(
		JSON.stringify([claim.userId, claim.organizationId, claim.kind]),
	);
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), payload);
	return `${b64(payload)}.${b64(new Uint8Array(sig))}`;
}

/** Null for a malformed or forged token. */
export async function verifyUnsubscribe(
	token: string,
	secret: string,
): Promise<UnsubscribeClaim | null> {
	const [p, s] = token.split(".");
	if (!p || !s) return null;
	try {
		const payload = unb64(p);
		const ok = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(secret),
			unb64(s),
			payload,
		);
		if (!ok) return null;
		const [userId, organizationId, kind] = JSON.parse(
			new TextDecoder().decode(payload),
		);
		if (typeof userId !== "string" || typeof organizationId !== "string")
			return null;
		return { userId, organizationId, kind };
	} catch {
		return null;
	}
}
