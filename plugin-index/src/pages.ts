import type { QueueVersion, Report } from "./admin.ts";
import type { Who } from "./auth.ts";
import type { OwnPlugin } from "./publish.ts";

// Minimal server-rendered pages: sign-in, a publisher dashboard and the admin queue. Plain
// forms posting to the same endpoints the CLI uses; every interpolated value goes through esc.

export const esc = (s: unknown) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const date = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#111214;--muted:#6b7079;--line:#e4e5e8;--tile:#f6f7f8}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--fg:#f1f2f4;--muted:#a7abb3;--line:#26282d;--tile:#1b1c20}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px}h1{font-size:22px}h2{font-size:17px;margin-top:32px}
.muted{color:var(--muted)}.msg{background:var(--tile);border:1px solid var(--line);border-radius:8px;padding:10px 14px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
form.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
input,textarea{font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
textarea{width:100%;box-sizing:border-box;min-height:90px;font:13px ui-monospace,Menlo,monospace}
button{font:inherit;border:0;border-radius:999px;padding:6px 14px;background:var(--fg);color:var(--bg);cursor:pointer}
button.ghost{background:var(--tile);color:var(--fg)}label{display:block;margin:10px 0 4px}
:focus-visible{outline:2px solid #4f8cff;outline-offset:2px}`;

export function page(title: string, body: string, msg?: string | null) {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${msg ? `<p class="msg" role="status">${esc(msg)}</p>` : ""}${body}</main></body></html>`,
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);
}

export const signInPage = (base: string, msg?: string | null) =>
	page(
		"LogiStack plugin index",
		`<h1>LogiStack plugin index</h1>
<p class="muted">Publish free plugins for LogiStack. Enter your email and we send you a sign-in link.</p>
<form method="post" action="${base}/auth/login" class="row">
<label for="email" class="muted">Email</label><input id="email" name="email" type="email" required autocomplete="email">
<button>Send link</button></form>`,
		msg,
	);

export const confirmPage = (base: string, token: string) =>
	page(
		"Sign in",
		`<h1>Sign in</h1><form method="post" action="${base}/auth/callback">
<input type="hidden" name="token" value="${esc(token)}"><button>Continue to the dashboard</button></form>`,
	);

export const tokenPage = (base: string, token: string) =>
	page(
		"API token",
		`<h1>API token</h1><p>Copy it now; it is not shown again.</p><p><code>${esc(token)}</code></p>
<p class="muted">Use it as <code>LOGISTACK_INDEX_TOKEN</code> with <code>logistack-plugin publish</code>.</p>
<p><a href="${base}/dashboard">Back to the dashboard</a></p>`,
	);

export function dashboardPage(
	base: string,
	who: Who,
	plugins: OwnPlugin[],
	tokens: {
		hash: string;
		name: string;
		created_at: number;
		last_used_at: number | null;
	}[],
	msg?: string | null,
) {
	const p = who.publisher;
	const pluginsHtml = plugins
		.map(
			(pl) => `<h3><code>${esc(pl.id)}</code></h3>
<table><thead><tr><th>Version</th><th>Status</th><th>Image</th><th>Notes</th><th>Submitted</th></tr></thead><tbody>
${pl.versions.map((v) => `<tr><td>${esc(v.version)}</td><td>${esc(v.status)}</td><td><code>${esc(v.image)}</code></td><td>${esc(v.review_notes)}</td><td>${date(v.created_at)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No versions yet.</td></tr>`}
</tbody></table>
<details><summary>Submit a version</summary>
<form method="post" action="${base}/me/plugins/${esc(pl.id)}/versions">
<label for="img-${esc(pl.id)}">Image, by digest</label><input id="img-${esc(pl.id)}" name="image" required size="70" placeholder="ghcr.io/acme/plugin@sha256:…">
<label for="man-${esc(pl.id)}">Manifest JSON (the image label)</label><textarea id="man-${esc(pl.id)}" name="manifest" required></textarea>
<label for="rd-${esc(pl.id)}">README (Markdown)</label><textarea id="rd-${esc(pl.id)}" name="readme"></textarea>
<label for="cl-${esc(pl.id)}">Changelog</label><textarea id="cl-${esc(pl.id)}" name="changelog"></textarea>
<label for="ic-${esc(pl.id)}">Icon URL (https, optional)</label><input id="ic-${esc(pl.id)}" name="iconUrl" size="70">
<p><button>Submit</button></p></form></details>`,
		)
		.join("");
	return page(
		"Plugin index dashboard",
		`<h1>Your plugins</h1>
<p class="muted">Signed in as ${esc(p.email)}${who.admin ? ` · <a href="${base}/admin">Admin queue</a>` : ""}</p>
${p.suspended_at ? `<p class="msg">This account is suspended: you cannot register plugins or submit versions.</p>` : ""}
<form method="post" action="${base}/me" class="row"><label for="name" class="muted">Publisher name (public)</label>
<input id="name" name="name" value="${esc(p.name)}" maxlength="60" required><button class="ghost">Save</button></form>
<h2>Register a plugin id</h2>
<form method="post" action="${base}/me/plugins" class="row"><input name="id" aria-label="Plugin id" placeholder="com.acme.my-plugin" required size="40"><button>Register</button></form>
${pluginsHtml || `<p class="muted">No plugins yet.</p>`}
<h2>API tokens</h2>
<table><tbody>${tokens.map((t) => `<tr><td>${esc(t.name)}</td><td class="muted">created ${date(t.created_at)}${t.last_used_at ? `, used ${date(t.last_used_at)}` : ""}</td><td><form method="post" action="${base}/me/tokens/${esc(t.hash)}/delete"><button class="ghost">Revoke</button></form></td></tr>`).join("") || `<tr><td class="muted">None.</td></tr>`}</tbody></table>
<form method="post" action="${base}/me/tokens" class="row"><input name="name" aria-label="Token name" placeholder="laptop" required><button class="ghost">Create token</button></form>
<form method="post" action="${base}/auth/logout"><p><button class="ghost">Sign out</button></p></form>`,
		msg,
	);
}

export function adminPage(
	base: string,
	versions: QueueVersion[],
	reports: Report[],
	msg?: string | null,
) {
	const act = (v: QueueVersion) => {
		const a = `${base}/admin/versions/${esc(v.id)}`;
		return [
			v.status === "unverified"
				? `<form method="post" action="${a}/verify" class="row"><input name="commit" aria-label="Reviewed commit" placeholder="commit SHA or URL" required><button>Verify</button></form>`
				: "",
			v.status !== "verified"
				? `<form method="post" action="${a}/reject" class="row"><input name="notes" aria-label="Reason" placeholder="reason" required><button class="ghost">Reject</button></form>`
				: "",
			v.status !== "pending"
				? `<form method="post" action="${a}/yank" class="row"><input name="notes" aria-label="Reason" placeholder="reason" required><button class="ghost">Yank</button></form>`
				: "",
		].join("");
	};
	const rows = versions
		.map(
			(
				v,
			) => `<tr><td><code>${esc(v.plugin_id)}</code> ${esc(v.version)}<br><span class="muted">${esc(v.status)}${v.reviewed_commit ? ` at ${esc(v.reviewed_commit)} by ${esc(v.reviewer)}` : ""}</span></td>
<td><code>${esc(v.image)}</code>${v.checks ? `<details><summary>CI checks</summary><code>${esc(v.checks)}</code></details>` : `<br><span class="muted">no CI checks yet</span>`}</td>
<td>${esc(v.publisher)}<br><span class="muted">${esc(v.publisher_email)}</span>${v.publisher_suspended ? "" : `<form method="post" action="${base}/admin/publishers/${esc(v.publisher_id)}/suspend" class="row"><input name="reason" aria-label="Suspension reason" placeholder="reason" required><button class="ghost">Suspend</button></form>`}</td>
<td>${act(v)}</td></tr>`,
		)
		.join("");
	const reportRows = reports
		.map(
			(
				r,
			) => `<tr><td><code>${esc(r.plugin_id)}</code> ${esc(r.version ?? "")}</td><td>${esc(r.reason)}<br><span class="muted">${esc(r.contact ?? "no contact")}, ${date(r.created_at)}</span></td>
<td><form method="post" action="${base}/admin/reports/${esc(r.id)}/resolve" class="row"><input name="resolution" aria-label="Resolution" placeholder="what was done" required><button class="ghost">Resolve</button></form></td></tr>`,
		)
		.join("");
	return page(
		"Plugin index admin",
		`<h1>Review queue</h1><p><a href="${base}/dashboard">Dashboard</a></p>
<table><thead><tr><th>Version</th><th>Image</th><th>Publisher</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="muted">Nothing to review.</td></tr>`}</tbody></table>
<h2>Open reports</h2>
<table><tbody>${reportRows || `<tr><td class="muted">No open reports.</td></tr>`}</tbody></table>`,
		msg,
	);
}
