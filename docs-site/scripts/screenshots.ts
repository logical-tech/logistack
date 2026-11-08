/**
 * Captures the dashboard screenshots the docs use, from the web app's in-memory mock API
 * (fake data, nothing real leaks). Start it first:
 *   VITE_API_MOCK=1 bun run --cwd apps/web dev --port 5199
 * then: bun run screenshots [baseUrl] [name-filter]
 */

import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const base = process.argv[2] ?? "http://localhost:5199";
const only = process.argv[3];
const out = join(import.meta.dir, "..", "public", "screens");

const P = "/projects/prj_storefront";
const SVC = `${P}/services/svc_storefront_production_web`;
const PG = `${P}/services/svc_storefront_production_postgres`;
const REDIS = `${P}/services/svc_storefront_production_redis`;
const AUTOSCALE = `${P}/services/svc_storefront_production_api/settings?scaling=setup&step=`;

/** A path, or a path plus the buttons/links to click (by accessible name, in order) before the shot. */
type Shot = string | { path: string; click: string[] };

/** name → shot. Names are what MDX pages reference: /screens/<name>.webp */
export const shots: Record<string, Shot> = {
	"sign-in": "/sign-in",
	"sign-up": "/sign-up",
	setup: "/setup",
	home: "/",
	projects: "/projects",
	project: P,
	"project-previews": `${P}/previews`,
	"project-gitops": `${P}/gitops`,
	"project-gitops-wizard": `${P}/gitops?step=manifest&edit=true`,
	"project-usage": `${P}/usage`,
	"project-import": `${P}/import`,
	"project-variables": `${P}/variables?env=env_storefront_production`,
	"environment-duplicate": `${P}/duplicate?from=env_storefront_production`,
	"service-new": `${P}/services/new`,
	"service-overview": SVC,
	"service-deployments": `${SVC}/deployments`,
	"service-logs": `${SVC}/logs`,
	"service-terminal": `${SVC}/terminal`,
	"service-environment": `${SVC}/environment`,
	"service-domains": `${SVC}/domains`,
	"service-metrics": `${SVC}/metrics`,
	"service-analytics": `${SVC}/analytics`,
	"service-storage": `${P}/services/svc_storefront_production_media/storage`,
	"service-settings": `${SVC}/settings`,
	"service-scaling": `${SVC}/settings#scaling`,
	"service-security": `${SVC}/security`,
	"autoscale-checks": `${AUTOSCALE}ready`,
	"autoscale-autofix": `${P}/services/svc_storefront_production_worker/settings?scaling=setup&step=ready`,
	"autoscale-range": `${AUTOSCALE}range`,
	"autoscale-behavior": `${AUTOSCALE}behavior`,
	"autoscale-review": `${AUTOSCALE}review`,
	"service-backups": `${PG}/backups`,
	"database-postgres": `${PG}/database`,
	"database-redis": `${REDIS}/database`,
	"database-operations": `${PG}/operations`,
	"database-public": `${PG}/operations?wizard=public&step=address`,
	"database-upgrade": `${PG}/operations?wizard=upgrade&step=version`,
	templates: `${P}/templates`,
	"template-detail": `${P}/templates/n8n?env=env_storefront_production`,
	stack: "/projects/prj_analytics/stacks/stk_analytics_plausible",
	"stack-compose":
		"/projects/prj_analytics/stacks/stk_analytics_plausible/compose",
	"stack-logs": "/projects/prj_analytics/stacks/stk_analytics_plausible/logs",
	"backup-new": "/backups/svc_storefront_production_postgres/new",
	"backup-restore": "/backups/svc_storefront_production_postgres/restore",
	schedules: "/schedules",
	"schedule-new": "/schedules/new",
	"schedule-detail": "/schedules/sch_vacuum",
	domains: "/domains",
	"domain-new": "/domains/new",
	network: "/network",
	storage: "/storage",
	monitoring: "/monitoring",
	"monitoring-alerts": "/monitoring/alerts",
	"monitoring-usage": "/monitoring/usage",
	uptime: "/monitoring/uptime",
	"uptime-monitor": "/monitoring/uptime/mon_api",
	"uptime-new": "/monitoring/uptime/new",
	incidents: "/monitoring/incidents",
	"status-pages": "/monitoring/status-pages",
	"monitoring-traffic": "/monitoring/traffic",
	nodes: "/monitoring/nodes",
	node: "/monitoring/nodes/node_fra1",
	"node-new": "/monitoring/nodes/new",
	patches: "/monitoring/patches",
	"patch-dialog": { path: "/monitoring/patches", click: ["Patch 3 nodes"] },
	git: "/integrations/git",
	"git-new": "/integrations/git/new",
	registries: "/integrations/registries",
	"registry-new": "/integrations/registries/new",
	s3: "/integrations/s3",
	"s3-new": "/integrations/s3/new",
	dns: "/integrations/dns",
	"dns-new": "/integrations/dns/new",
	"dns-zone": "/integrations/dns/dns_cf_logical/z_logical",
	tunnels: "/integrations/tunnels",
	"tunnel-new": "/integrations/tunnels/new",
	agent: "/agent",
	"log-drains": "/integrations/log-drains",
	"log-drain-new": "/integrations/log-drains/new",
	tailscale: "/integrations/tailscale",
	"tailscale-new": "/integrations/tailscale/new",
	notifications: "/integrations/notifications",
	"notification-new": "/integrations/notifications/new",
	"secret-providers": "/integrations/secret-providers",
	"secret-provider-new": "/integrations/secret-providers/new",
	"settings-general": "/settings/general",
	"settings-members": "/settings/members",
	"settings-roles": "/settings/roles",
	"settings-api-keys": "/settings/api-keys",
	"api-key-new": "/settings/api-keys/new",
	"settings-authentication": "/settings/authentication",
	"settings-oidc": "/settings/authentication/oidc",
	"settings-saml": "/settings/authentication/saml",
	"settings-builds": "/settings/builds",
	"settings-emulation": "/settings/builds/emulation",
	"settings-certificates": "/settings/certificates",
	"certificate-new": "/settings/certificates/new",
	"certificate-origin": "/settings/certificates/origin",
	"settings-ssh-keys": "/settings/ssh-keys",
	"settings-instance-admins": "/settings/instance-admins",
	"settings-updates": "/settings/updates",
	"settings-updates-changelog": "/settings/updates#changelog",
	"settings-updates-channel": "/settings/updates#settings",
	"settings-appearance": "/settings/appearance",
	"settings-variables": "/settings/variables",
	"settings-audit-log": "/settings/audit-log",
	"settings-migrate": "/settings/migrate",
	"account-security": "/account/security",
	"two-factor-challenge": "/two-factor",
	"sign-in-sso": { path: "/sign-in", click: ["Continue with SSO"] },
	"project-new-dialog": { path: "/projects", click: ["New project"] },
	"environment-menu": { path: P, click: ["Production settings"] },
	"invite-dialog": { path: "/settings/members", click: ["Invite member"] },
	"role-editor": { path: "/settings/roles", click: ["Create role"] },
	"domain-add-dialog": { path: `${SVC}/domains`, click: ["Add domain"] },
	"dns-record-edit": {
		path: "/integrations/dns/dns_cf_logical/z_logical",
		click: ["Add record"],
	},
	"settings-updates-confirm": {
		path: "/settings/updates",
		click: ["Update to v0.2.0"],
	},
	"certificate-authority": {
		path: "/settings/certificates",
		click: ["Certificate authority"],
	},
	"settings-plugins": "/settings/plugins",
	"plugins-marketplace": "/settings/plugins?tab=marketplace",
	"plugin-install-review":
		"/settings/plugins/new?index=pidx_acme&plugin=com.acme.cost-report&version=1.2.0&step=review",
	"plugin-detail": "/settings/plugins/plg_deployalerts",
	"plugin-update": {
		path: "/settings/plugins/plg_deployalerts",
		click: ["Check for updates"],
	},
	"plugin-page": "/plugin/plg_deployalerts/failures",
};

// The mock has no plugin container behind /plugins/<id>/ui/*: serve a stand-in page that speaks
// the bridge like the deploy-notifier example, styled with the SDK's CSS kit.
const kit = await Bun.file(
	join(import.meta.dir, "../../packages/plugin-sdk/src/ui.css"),
).text();
const pluginPage = `<!doctype html><meta charset="utf-8"><style>${kit}</style>
<div id="root" class="ls-stack"></div><script>
const rows = [["2 min ago","storefront-web","Health check failed on port 3000","Posted"],
["1 hour ago","booking-api","Build failed: npm ci exited with code 1","Posted"],
["Yesterday","storefront-worker","Image pull failed: manifest unknown","Not posted"]];
addEventListener("message", (e) => {
	if (e.data?.type !== "init") return;
	for (const [k, v] of Object.entries(e.data.css)) document.documentElement.style.setProperty(k, v);
	document.documentElement.style.colorScheme = e.data.theme;
	root.innerHTML = '<div><h1>Deploy alerts</h1><p class="ls-muted">Failed deployments posted to your chat webhook, newest first.</p></div>'
		+ '<div class="ls-card" style="padding:0"><table class="ls-table"><thead><tr><th>When</th><th>Event</th><th>Service</th><th>Message</th><th>Chat</th></tr></thead><tbody>'
		+ rows.map((r) => '<tr><td class="ls-muted">' + r[0] + '</td><td><span class="ls-badge" data-tone="bad">Failed</span></td><td class="ls-mono">' + r[1] + '</td><td>' + r[2] + '</td><td><span class="ls-badge" data-tone="' + (r[3] === "Posted" ? "ok" : "warn") + '">' + r[3] + '</span></td></tr>').join("")
		+ '</tbody></table></div>';
});
parent.postMessage({ type: "ready" }, "*");
</script>`;

// PLAYWRIGHT_CHROME points at any Chromium when `bunx playwright install` was not run.
const browser = await chromium.launch({
	executablePath: process.env.PLAYWRIGHT_CHROME,
});
const ctx = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	deviceScaleFactor: 2,
	colorScheme: "dark",
	reducedMotion: "reduce",
});
await ctx.route("**/plugins/*/ui/**", (route) =>
	route.fulfill({ contentType: "text/html", body: pluginPage }),
);
const page = await ctx.newPage();
const failed: string[] = [];
for (const [name, shot] of Object.entries(shots)) {
	if (only && !name.includes(only)) continue;
	const { path, click } =
		typeof shot === "string" ? { path: shot, click: [] } : shot;
	try {
		await page.goto(base + path, { waitUntil: "networkidle" });
		// The mock API answers after a short simulated latency; let skeletons settle.
		await page.waitForTimeout(1200);
		// The section renders after the mock answers, too late for the browser's own jump.
		const hash = new URL(base + path).hash;
		if (hash)
			await page
				.locator(hash)
				.evaluate((el) => el.scrollIntoView({ block: "start" }));
		for (const label of click) {
			await page
				.getByRole("button", { name: label })
				.or(page.getByRole("link", { name: label }))
				.first()
				.click({ timeout: 5000 });
			await page.waitForTimeout(800);
		}
		const png = await page.screenshot();
		await sharp(png)
			.resize({ width: 1600 })
			.webp({ quality: 82 })
			.toFile(join(out, `${name}.webp`));
		const url = page.url();
		console.log(`${name.padEnd(26)} ${url.replace(base, "")}`);
	} catch (e) {
		failed.push(name);
		console.error(`${name} failed: ${(e as Error).message}`);
	}
}
await browser.close();
if (failed.length) console.error(`failed: ${failed.join(", ")}`);
