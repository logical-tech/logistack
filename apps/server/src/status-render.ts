import type {
	IncidentImpact,
	IncidentStatus,
	MonitorStatus,
	StatusPageTheme,
	UptimeDay,
} from "@logistack/contracts";

// Pure HTML/SVG for public status pages and badges: no client JS, every value escaped.

export type PageData = {
	title: string;
	description: string;
	theme: StatusPageTheme;
	overall: "operational" | "degraded" | "outage" | "maintenance";
	sections: {
		name: string;
		monitors: {
			id: string;
			label: string;
			status: MonitorStatus;
			uptime: number | null;
			bars: UptimeDay[];
		}[];
	}[];
	incidents: {
		title: string;
		status: IncidentStatus;
		impact: IncidentImpact;
		startedAt: Date;
		resolvedAt: Date | null;
		updates: { status: IncidentStatus; message: string; createdAt: Date }[];
	}[];
	maintenance: {
		title: string;
		description: string;
		startsAt: Date;
		endsAt: Date;
		active: boolean;
	}[];
	historyDays: number;
	generatedAt: Date;
};

export const escapeHtml = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(ch) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				ch
			] as string,
	);

const OVERALL = {
	operational: "All systems operational",
	degraded: "Some systems are down",
	outage: "Major outage",
	maintenance: "Scheduled maintenance in progress",
} as const;

const STATUS_LABEL: Record<MonitorStatus, string> = {
	up: "Operational",
	down: "Down",
	pending: "Checking",
	maintenance: "Maintenance",
	paused: "Paused",
};

const INCIDENT_LABEL: Record<IncidentStatus, string> = {
	investigating: "Investigating",
	identified: "Identified",
	monitoring: "Monitoring",
	resolved: "Resolved",
};

const pct = (n: number | null) =>
	n === null ? "–" : `${n >= 99.995 ? "100" : n.toFixed(2)}%`;

const fmtDate = (d: Date) =>
	d.toLocaleString("en-GB", {
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "UTC",
		timeZoneName: "short",
	});

const fmtDay = (day: string) =>
	new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
	});

function bars(days: UptimeDay[]) {
	const w = 100 / days.length;
	const rects = days
		.map((d, i) => {
			const tip = `${fmtDay(d.day)}: ${d.status === "none" ? "no data" : d.status === "maintenance" ? "maintenance" : pct(d.uptime)}`;
			return `<rect x="${(i * w).toFixed(3)}%" width="${(w * 0.72).toFixed(3)}%" height="100%" rx="1.5" class="d-${d.status}"><title>${escapeHtml(tip)}</title></rect>`;
		})
		.join("");
	return `<svg class="bars" role="img" aria-label="Daily uptime, last ${days.length} days" preserveAspectRatio="none">${rects}</svg>`;
}

const CSS = `
:root{--bg:#fff;--fg:#0a0a0a;--muted:#6b7280;--line:#e5e7eb;--card:#fafafa;--up:#16a34a;--deg:#ca8a04;--down:#dc2626;--maint:#2563eb;--none:#e5e7eb}
@media (prefers-color-scheme:dark){:root:not(.light){--bg:#0a0a0a;--fg:#fafafa;--muted:#9ca3af;--line:#262626;--card:#111;--none:#262626}}
:root.dark{--bg:#0a0a0a;--fg:#fafafa;--muted:#9ca3af;--line:#262626;--card:#111;--none:#262626}
*{box-sizing:border-box}html{background:var(--bg);color:var(--fg)}
body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:48px 16px 64px}
header{display:flex;align-items:center;gap:12px;margin-bottom:8px}
header img{height:32px;width:auto}
h1{font-size:22px;font-weight:600;letter-spacing:-.01em;margin:0}
.desc{color:var(--muted);margin:0 0 28px}
.banner{display:flex;align-items:center;gap:10px;padding:16px 18px;border-radius:12px;border:1px solid var(--line);background:var(--card);font-weight:500;margin-bottom:36px}
.banner .dot{width:10px;height:10px;border-radius:99px;background:var(--accent)}
.banner.degraded .dot{background:var(--deg)}.banner.outage .dot{background:var(--down)}.banner.maintenance .dot{background:var(--maint)}
section{margin-bottom:32px}
h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
.card{border:1px solid var(--line);border-radius:12px;overflow:hidden}
.mon{padding:14px 18px;border-top:1px solid var(--line)}.mon:first-child{border-top:0}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:8px}
.name{font-weight:500}.meta{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
.st{font-size:13px;font-weight:500}.st-up{color:var(--up)}.st-down{color:var(--down)}.st-maintenance{color:var(--maint)}.st-pending,.st-paused{color:var(--muted)}
.bars{display:block;width:100%;height:30px}
.d-up{fill:var(--up)}.d-degraded{fill:var(--deg)}.d-down{fill:var(--down)}.d-maintenance{fill:var(--maint)}.d-none{fill:var(--none)}
.axis{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:4px}
.inc{padding:16px 18px;border-top:1px solid var(--line)}.inc:first-child{border-top:0}
.inc h3{font-size:15px;margin:0 0 6px;font-weight:600}
.upd{margin:8px 0 0;padding-left:12px;border-left:2px solid var(--line)}
.upd b{font-weight:600}.upd p{margin:2px 0 0;white-space:pre-wrap}.upd time{color:var(--muted);font-size:12px}
.empty{color:var(--muted);padding:16px 18px}
footer{color:var(--muted);font-size:13px;display:flex;justify-content:space-between;gap:12px;margin-top:48px}
footer a{color:inherit}
`;

export function renderStatusPage(p: PageData): string {
	const t = p.theme;
	const htmlClass = t.appearance === "auto" ? "" : ` class="${t.appearance}"`;
	const sections = p.sections
		.map(
			(s) =>
				`<section>${s.name ? `<h2>${escapeHtml(s.name)}</h2>` : ""}<div class="card">${s.monitors
					.map(
						(m) =>
							`<div class="mon"><div class="row"><span class="name">${escapeHtml(m.label)}</span><span class="st st-${m.status}">${STATUS_LABEL[m.status]}</span></div>${bars(m.bars)}<div class="axis"><span>${p.historyDays} days ago</span><span>${pct(m.uptime)} uptime</span><span>Today</span></div></div>`,
					)
					.join("")}</div></section>`,
		)
		.join("");
	const maint = p.maintenance.length
		? `<section><h2>Maintenance</h2><div class="card">${p.maintenance
				.map(
					(m) =>
						`<div class="inc"><h3>${escapeHtml(m.title)}</h3><div class="meta">${m.active ? "In progress · " : ""}${fmtDate(m.startsAt)} – ${fmtDate(m.endsAt)}</div>${m.description ? `<p>${escapeHtml(m.description)}</p>` : ""}</div>`,
				)
				.join("")}</div></section>`
		: "";
	const incidents = `<section><h2>Incidents</h2><div class="card">${
		p.incidents.length
			? p.incidents
					.map(
						(i) =>
							`<div class="inc"><h3>${escapeHtml(i.title)}</h3><div class="meta">${INCIDENT_LABEL[i.status]} · ${fmtDate(i.startedAt)}${i.resolvedAt ? ` – ${fmtDate(i.resolvedAt)}` : ""}</div>${i.updates
								.map(
									(u) =>
										`<div class="upd"><b>${INCIDENT_LABEL[u.status]}</b> <time datetime="${u.createdAt.toISOString()}">${fmtDate(u.createdAt)}</time><p>${escapeHtml(u.message)}</p></div>`,
								)
								.join("")}</div>`,
					)
					.join("")
			: `<div class="empty">No incidents in the last ${p.historyDays} days.</div>`
	}</div></section>`;
	return `<!doctype html><html lang="en"${htmlClass}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(p.title)} status</title><meta name="description" content="${escapeHtml(p.description || `${p.title} status`)}"><style>${CSS}:root{--accent:${t.accent}}</style></head><body><main><header>${t.logoUrl ? `<img src="${escapeHtml(t.logoUrl)}" alt="">` : ""}<h1>${escapeHtml(p.title)}</h1></header>${p.description ? `<p class="desc">${escapeHtml(p.description)}</p>` : `<p class="desc"></p>`}<div class="banner ${p.overall}"><span class="dot"></span>${OVERALL[p.overall]}</div>${maint}${sections}${incidents}<footer><span>Updated ${fmtDate(p.generatedAt)}</span>${t.websiteUrl ? `<a href="${escapeHtml(t.websiteUrl)}" rel="noopener">${escapeHtml(new URL(t.websiteUrl).hostname)}</a>` : ""}<span>Powered by LogiStack</span></footer></main></body></html>`;
}

const BADGE_COLOR = {
	up: "#16a34a",
	degraded: "#ca8a04",
	down: "#dc2626",
	maintenance: "#2563eb",
	unknown: "#6b7280",
} as const;
export type BadgeColor = keyof typeof BADGE_COLOR;

/** A flat shields-style badge; text width estimated at 6.5 px per character. */
export function badgeSvg(
	label: string,
	value: string,
	color: BadgeColor,
): string {
	const lw = Math.round(label.length * 6.5 + 12);
	const vw = Math.round(value.length * 6.5 + 12);
	const w = lw + vw;
	const l = escapeHtml(label);
	const v = escapeHtml(value);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${v}"><title>${l}: ${v}</title><clipPath id="r"><rect width="${w}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${BADGE_COLOR[color]}"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${l}</text><text x="${lw + vw / 2}" y="14">${v}</text></g></svg>`;
}

export function statusBadge(status: MonitorStatus | undefined) {
	const map: Record<MonitorStatus, [string, BadgeColor]> = {
		up: ["up", "up"],
		down: ["down", "down"],
		maintenance: ["maintenance", "maintenance"],
		pending: ["pending", "unknown"],
		paused: ["paused", "unknown"],
	};
	const [v, c] = status ? map[status] : ["unknown", "unknown" as const];
	return badgeSvg("status", v, c);
}

export function uptimeBadge(uptime: number | null, days: number) {
	const color: BadgeColor =
		uptime === null
			? "unknown"
			: uptime >= 99.9
				? "up"
				: uptime >= 99
					? "degraded"
					: "down";
	return badgeSvg(`uptime ${days}d`, pct(uptime), color);
}
