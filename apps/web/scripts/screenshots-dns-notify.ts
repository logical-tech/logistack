/**
 * Screenshots of DNS providers, domains, certificates and notifications into
 * docs/screenshots/dns-notify/, light and dark at 1440 and 390 px.
 *
 *   VITE_API_MOCK=1 bunx vite --port 5199 &
 *   bun scripts/screenshots-dns-notify.ts [baseUrl] [shot names...]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	capture,
	connect,
	fill,
	launchChrome,
	type Page,
	sleep,
	submit,
	waitFor,
} from "./cdp";

const BASE = process.argv[2] ?? "http://localhost:5199";
const ONLY = new Set(process.argv.slice(3));
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "dns-notify");
const PORT = 9334;

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

const hasText = (t: string) =>
	`document.body.innerText.includes(${JSON.stringify(t)})`;
const click = (text: string, selector = "button, [role=radio], a, label") =>
	`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)})); el?.click(); return Boolean(el); })()`;

async function next(page: Page, ready: string) {
	await page.eval(submit);
	await waitFor(page, ready);
}

type Shot = {
	name: string;
	path: string;
	ready: string;
	steps?: (page: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
	{
		name: "dns-providers",
		path: "/integrations/dns",
		ready: hasText("Cloudflare · Logical"),
	},
	{
		name: "dns-wizard-credentials",
		path: "/integrations/dns/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await next(page, `!!document.querySelector("#wz-cred-apiToken")`);
			await page.eval(fill("#wz-cred-apiToken", "cf-token-0123456789abcdef"));
		},
	},
	{
		name: "dns-wizard-zones",
		path: "/integrations/dns/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await next(page, `!!document.querySelector("#wz-cred-apiToken")`);
			await page.eval(fill("#wz-cred-apiToken", "cf-token-0123456789abcdef"));
			await next(page, hasText("Test connection"));
			await page.eval(click("Test connection"));
			await waitFor(page, hasText("Test again"));
			await next(page, hasText("Select all"));
			await page.eval(click("logical.it", "label"));
			await page.eval(click("acme-retail.it", "label"));
		},
	},
	{ name: "domains", path: "/domains", ready: hasText("shop.acme-retail.it") },
	{
		name: "add-domain-dns",
		path: "/domains/new?serviceId=svc_storefront_production_web",
		ready: `!!document.querySelector("#wz-serviceId")`,
		steps: async (page) => {
			await next(page, `!!document.querySelector("#wz-hostname")`);
			await page.eval(fill("#wz-hostname", "checkout.acme-retail.it"));
			await page.eval(fill("#wz-port", "3000"));
			await next(page, hasText("is managed by"));
			await page.eval(click("Create the record for me", "[role=radio]"));
			await waitFor(page, `!!document.querySelector("#wz-proxied")`);
			await page.eval(`document.querySelector("#wz-proxied").click(); true`);
			await waitFor(page, hasText("Full (strict)"));
		},
	},
	{
		name: "add-domain-propagation",
		path: "/domains/new?serviceId=svc_storefront_production_web",
		ready: `!!document.querySelector("#wz-serviceId")`,
		steps: async (page) => {
			await next(page, `!!document.querySelector("#wz-hostname")`);
			await page.eval(fill("#wz-hostname", "checkout.acme-retail.it"));
			await page.eval(fill("#wz-port", "3000"));
			await next(page, hasText("is managed by"));
			await page.eval(click("Create the record for me", "[role=radio]"));
			await next(page, hasText("Create record"));
			await page.eval(click("Create record"));
			await waitFor(page, hasText("Test again"));
			await next(page, hasText("Checking"));
			await sleep(2600);
		},
	},
	{
		name: "add-domain-tls",
		path: "/domains/new?serviceId=svc_storefront_production_web",
		ready: `!!document.querySelector("#wz-serviceId")`,
		steps: async (page) => {
			await next(page, `!!document.querySelector("#wz-hostname")`);
			await page.eval(fill("#wz-hostname", "status.logical.it"));
			await next(page, hasText("is managed by"));
			await next(page, hasText("Propagation"));
			await next(page, hasText("How the proxy gets a certificate"));
		},
	},
	{
		name: "certificates",
		path: "/settings/certificates",
		ready: hasText("Acme office (Sectigo)"),
		steps: async (page) => {
			await page.eval(click("Certificate authority", "button"));
			await waitFor(page, hasText("Let's Encrypt staging"));
		},
	},
	{
		name: "certificate-upload",
		path: "/settings/certificates/new",
		ready: `!!document.querySelector("#wz-certPem")`,
		steps: async (page) => {
			await page.eval(
				fill(
					"#wz-certPem",
					"-----BEGIN CERTIFICATE-----\nMIIF...\n-----END CERTIFICATE-----",
				),
			);
			await page.eval(
				fill(
					"#wz-privateKey",
					"-----BEGIN PRIVATE KEY-----\nMIGH...\n-----END PRIVATE KEY-----",
				),
			);
			await next(page, hasText("Check certificate"));
			await page.eval(click("Check certificate"));
			await waitFor(page, hasText("Test again"));
		},
	},
	{
		name: "notifications",
		path: "/integrations/notifications",
		ready: hasText("#ops-alerts"),
	},
	{
		name: "notifications-rule-editor",
		path: "/integrations/notifications?rule=nch_ops",
		ready: hasText("Save rule"),
	},
	{
		name: "channel-wizard-email",
		path: "/integrations/notifications/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await page.eval(click("Email", "[role=radio]"));
			await next(page, hasText("SMTP server"));
		},
	},
];

async function main() {
	await mkdir(OUT, { recursive: true });
	const chrome = await launchChrome(PORT);
	try {
		for (const theme of THEMES) {
			for (const vp of VIEWPORTS) {
				const page = await connect(PORT);
				await page.send("Page.enable");
				await page.send("Emulation.setEmulatedMedia", {
					features: [
						{ name: "prefers-color-scheme", value: theme },
						{ name: "prefers-reduced-motion", value: "reduce" },
					],
				});
				for (const shot of SHOTS) {
					if (ONLY.size && !ONLY.has(shot.name)) continue;
					await page.send("Emulation.setDeviceMetricsOverride", {
						width: vp.width,
						height: vp.height,
						deviceScaleFactor: vp.mobile ? 2 : 1,
						mobile: vp.mobile,
					});
					await page.send("Page.navigate", { url: `${BASE}/sign-in` });
					await sleep(400);
					await page.eval(
						`localStorage.setItem("ls-theme", "${theme}"); localStorage.setItem("ls-mock-signed-in", "1"); sessionStorage.clear(); true`,
					);
					await page.send("Page.navigate", { url: `${BASE}${shot.path}` });
					try {
						await waitFor(page, shot.ready, 10_000);
						await shot.steps?.(page);
					} catch (err) {
						console.error(`${shot.name} ${theme} ${vp.name}: ${String(err)}`);
					}
					await sleep(700);
					const file = join(OUT, `${shot.name}-${theme}-${vp.name}.png`);
					await capture(page, file, vp);
					console.log(`saved ${file}`);
				}
			}
		}
	} finally {
		await chrome.close();
	}
}
await main();
