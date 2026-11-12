export type Branding = {
	orgName: string;
	/** A PNG, WebP or JPEG data URL, as the organization stores it. */
	logo?: string | null;
};

const escapeHtml = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] as string,
	);

const STYLE =
	"<style>:root{color-scheme:light dark;--fg:#171717;--muted:#666;--bg:#fafafa;--line:#e5e5e5}" +
	"@media(prefers-color-scheme:dark){:root{--fg:#ededed;--muted:#a1a1a1;--bg:#0a0a0a;--line:#262626}}" +
	"body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);" +
	"font:15px/1.6 system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}" +
	"main{max-width:28rem;padding:2rem 1.5rem}img{border-radius:8px;display:block;margin-bottom:1.5rem}" +
	"h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem;text-wrap:balance}p{margin:0;color:var(--muted)}" +
	"footer{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}</style>";

/** A self-contained page (no external requests) in the organization's name, light and dark. */
export function brandedPage(
	b: Branding,
	page: { title: string; heading: string; message: string },
): string {
	const logo =
		b.logo &&
		/^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(b.logo)
			? `<img src="${b.logo}" alt="" width="40" height="40">`
			: "";
	return (
		'<!doctype html><html lang="en"><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width,initial-scale=1">' +
		`<title>${escapeHtml(page.title)} · ${escapeHtml(b.orgName)}</title>${STYLE}` +
		`</head><body><main>${logo}<h1>${escapeHtml(page.heading)}</h1>` +
		`<p>${escapeHtml(page.message)}</p><footer>${escapeHtml(b.orgName)}</footer></main></body></html>`
	);
}

export const maintenancePage = (b: Branding, message?: string | null) =>
	brandedPage(b, {
		title: "Under maintenance",
		heading: "We'll be right back",
		message:
			message?.trim() ||
			"This site is down for scheduled maintenance. Please check back shortly.",
	});

/** One page for 502, 503 and 504: the status code is in the response, not the body. */
export const unavailablePage = (b: Branding) =>
	brandedPage(b, {
		title: "Temporarily unavailable",
		heading: "This site is temporarily unavailable",
		message:
			"The application did not respond, often because a new version is starting. Try again in a moment.",
	});

/**
 * What a visitor on the server's own network sees on plain http at an address Caddy does not
 * route (the raw IP, the bootstrap sslip.io name): where the dashboard went.
 */
export function movedPage(dashboardHostname: string): string {
	const origin = escapeHtml(`https://${dashboardHostname}`);
	return (
		'<!doctype html><html lang="en"><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width,initial-scale=1">' +
		`<title>LogiStack has moved</title>${STYLE}` +
		"<style>a{color:inherit}code{font-size:13px;overflow-wrap:anywhere}</style></head><body><main>" +
		`<h1>LogiStack is at <a href="${origin}/">${origin}</a></h1>` +
		"<p>If that link does not open from this network, the name probably points at the public " +
		"address and the router does not loop it back. Point the record at this server's local " +
		"address, forward ports 80 and 443, or add a local DNS record.</p>" +
		"<footer>Locked out? The dashboard also listens on the server's 127.0.0.1. Open an SSH " +
		"tunnel with the command the installer printed (<code>ssh -L 3000:127.0.0.1:3000 root@&lt;server&gt;</code>), " +
		"then open <code>http://localhost:3000</code>.</footer></main></body></html>"
	);
}
