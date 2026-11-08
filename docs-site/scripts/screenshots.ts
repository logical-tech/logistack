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
	nodes: "/monitoring/nodes",
	node: "/monitoring/nodes/node_fra1",
	"node-new": "/monitoring/nodes/new",
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
	"certificate-authority": {
		path: "/settings/certificates",
		click: ["Certificate authority"],
	},
};

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
