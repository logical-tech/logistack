/**
 * The sponsor-key email, in the marketing site's look: dark surface, Mona Sans with system
 * fallbacks, pill buttons. Tables and inline styles only, because mail clients ignore most CSS;
 * the logo is built from cells since Gmail drops SVG.
 */
const C = {
	bg: "#111214",
	tile: "#1b1c20",
	line: "#26282d",
	fg: "#f1f2f4",
	muted: "#a7abb3",
	faint: "#8a8f98",
	ok: "#4fd08b",
};
const SANS =
	"'Mona Sans','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO =
	"'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

const SITE = "https://stack.logicaltech.it";
const PORTAL = "https://billing.stripe.com/p/login/5kQ7sFbPX2YIcX4bPz1gs00";

export type KeyEmail = {
	key: string;
	monthly: boolean;
	/** Unix seconds: when this key stops working. */
	exp: number;
	sandbox?: boolean;
	/** From the payment page, already cleaned; still escaped here since the sponsor typed it. */
	name?: string | null;
	/** The sponsor's LogiStack origin: the email links straight to its Settings > Sponsor. */
	instance?: string | null;
};

const esc = (s: string) =>
	s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const date = (s: number) =>
	new Date(s * 1000).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
	});

const bar = (width: number, color: string, gap: number) =>
	`<tr><td style="padding:0 0 ${gap}px 0;font-size:0;line-height:0"><div style="width:${width}px;height:4px;border-radius:1.5px;background:${color};font-size:0;line-height:0">&nbsp;</div></td></tr>`;

/** The site's mark (icon.svg) at 32px: a light rounded square, three bars, the last one green. */
const mark = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td style="width:24px;height:24px;border-radius:8px;background:${C.fg};padding:8px 0 0 8px;vertical-align:top;font-size:0;line-height:0"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${bar(16, C.bg, 2)}${bar(11, C.bg, 2)}${bar(7, C.ok, 0)}</table></td></tr></table>`;

function pill(href: string, label: string, primary: boolean) {
	const style = primary
		? `background:${C.fg};color:${C.bg};`
		: `background:${C.tile};color:${C.fg};`;
	return `<a href="${href}" style="${style}display:inline-block;margin:0 0 8px 0;padding:12px 22px;border-radius:999px;font-family:${SANS};font-size:15px;font-weight:600;line-height:20px;text-decoration:none">${label}</a>`;
}

export function renderKeyEmail(e: KeyEmail) {
	const until = date(e.exp);
	const renewal = e.monthly
		? `Your instance renews this key by itself every month while the sponsorship is active. If it can't reach us, the key keeps working until ${until}.`
		: `The key is valid until ${until}.`;
	const subject = `${e.sandbox ? "[Sandbox] " : ""}Your LogiStack sponsor key`;
	const heading = e.name
		? `Thank you, ${esc(e.name)}.`
		: "Thank you for sponsoring LogiStack.";
	// The key travels in the fragment, which browsers never send to a server or log.
	const activate = e.instance
		? `${e.instance}/settings/sponsor#key=${e.key}`
		: null;
	const host = e.instance ? new URL(e.instance).host : null;
	const wallNote = e.name
		? `<p style="margin:16px 0 0 0;font-family:${SANS};font-size:15px;line-height:24px;color:${C.muted}">Your name is on the <a href="${SITE}/#sponsor" style="color:${C.fg};text-decoration:underline">sponsors list</a> for as long as the sponsorship lasts.</p>`
		: "";

	const text = [
		e.name ? `Thank you, ${e.name}.` : "Thank you for sponsoring LogiStack.",
		"",
		"Your sponsor key:",
		e.key,
		"",
		activate ? `Activate it on ${host}: ${activate}\n` : "",
		"1. In LogiStack, open Settings, then Sponsor.",
		"2. Paste the key and choose Activate.",
		"",
		renewal,
		e.monthly ? `\nChange your card or cancel: ${PORTAL}` : "",
		"",
		`LogiStack · ${SITE}`,
		"Made in Italy by Logical",
	].join("\n");

	const p = (body: string, color = C.muted, extra = "") =>
		`<p style="margin:0;font-family:${SANS};font-size:16px;line-height:26px;color:${color};${extra}">${body}</p>`;

	const step = (n: number, body: string) =>
		`<tr><td style="width:28px;vertical-align:top;padding:0 0 10px 0;font-family:${MONO};font-size:13px;line-height:24px;color:${C.faint}">0${n}</td><td style="vertical-align:top;padding:0 0 10px 0;font-family:${SANS};font-size:15px;line-height:24px;color:${C.fg}">${body}</td></tr>`;

	const sandboxChip = e.sandbox
		? `<td style="padding-left:10px"><span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${C.tile};font-family:${MONO};font-size:11px;line-height:16px;color:${C.muted}">sandbox</span></td>`
		: "";

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${subject}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Mona+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>:root{color-scheme:dark}@media (max-width:600px){.px{padding-left:20px!important;padding-right:20px!important}.h1{font-size:34px!important;line-height:38px!important}}</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your key turns on sponsor mode in LogiStack. Paste it in Settings, then Sponsor.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}">
<tr><td align="center" style="padding:40px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">

<tr><td class="px" style="padding:0 32px 48px 32px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle">${mark}</td>
<td style="vertical-align:middle;padding-left:10px;font-family:${SANS};font-size:17px;font-weight:600;letter-spacing:-0.01em;color:${C.fg}">LogiStack</td>
${sandboxChip}
</tr></table>
</td></tr>

<tr><td class="px" style="padding:0 32px">
<h1 class="h1" style="margin:0 0 20px 0;font-family:${SANS};font-size:44px;line-height:46px;font-weight:500;letter-spacing:-0.04em;color:${C.fg}">${heading}</h1>
${p("Your payment went through. It pays for the hours behind releases, security fixes and the template catalog. Here is the key that turns on sponsor mode in your instance.")}
</td></tr>

<tr><td class="px" style="padding:36px 32px 0 32px">
<p style="margin:0 0 10px 0;font-family:${SANS};font-size:15px;font-weight:500;color:${C.fg}">Your sponsor key</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:${C.tile};border-radius:16px;padding:18px 20px;font-family:${MONO};font-size:13px;line-height:21px;color:${C.fg};word-break:break-all">${e.key}</td>
</tr></table>
</td></tr>

<tr><td class="px" style="padding:28px 32px 0 32px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
${step(1, 'In LogiStack, open <b style="font-weight:600">Settings</b>, then <b style="font-weight:600">Sponsor</b>.')}
${step(2, 'Paste the key and choose <b style="font-weight:600">Activate</b>.')}
</table>
${p(renewal, C.muted, "margin-top:10px;font-size:15px;line-height:24px")}
${wallNote}
</td></tr>

<tr><td class="px" style="padding:32px 32px 0 32px">
${[
	activate && host ? pill(activate, `Activate on ${esc(host)}`, true) : "",
	e.monthly ? pill(PORTAL, "Manage sponsorship", !activate) : "",
	pill(SITE, "Visit the site", !activate && !e.monthly),
]
	.filter(Boolean)
	.join("&nbsp;&nbsp;")}
</td></tr>

<tr><td class="px" style="padding:56px 32px 0 32px">
<div style="border-top:1px solid ${C.line};font-size:0;line-height:0">&nbsp;</div>
<p style="margin:20px 0 0 0;font-family:${SANS};font-size:13px;line-height:20px;color:${C.faint}">You get this email because you sponsored LogiStack. Every feature works without a key; it adds a badge and hides the sponsorship cards.</p>
<p style="margin:12px 0 0 0;font-family:${SANS};font-size:13px;line-height:20px;color:${C.faint}">Made in Italy by <a href="https://logicaltech.it" style="color:${C.muted};text-decoration:underline">Logical</a> · <a href="${SITE}" style="color:${C.muted};text-decoration:underline">stack.logicaltech.it</a></p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

	return { subject, text, html };
}
