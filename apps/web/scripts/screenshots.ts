/**
 * Captures the verification screenshots in docs/screenshots/ through the Chrome
 * DevTools Protocol: every screen in light and dark, at 1440 and 390 px wide.
 *
 *   VITE_API_MOCK=1 bun run dev -- --port 5199 &
 *   bun scripts/screenshots.ts [baseUrl]
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
const OUT = join(import.meta.dir, "..", "docs", "screenshots");
const PORT = 9333;

type Viewport = {
	name: string;
	width: number;
	height: number;
	mobile: boolean;
};
const VIEWPORTS: Viewport[] = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

type Shot = {
	name: string;
	path: string;
	ready: string;
	steps?: (page: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
	{
		name: "sign-in",
		path: "/sign-in",
		ready: `!!document.querySelector("#email")`,
	},
	{
		name: "setup-1-owner",
		path: "/setup",
		ready: `!!document.querySelector("#wz-ownerName")`,
	},
	{
		name: "setup-3-domain",
		path: "/setup",
		ready: `!!document.querySelector("#wz-ownerName")`,
		steps: async (page) => {
			await page.eval(fill("#wz-ownerName", "Simone Maddiona"));
			await page.eval(fill("#wz-ownerEmail", "simone@logical.it"));
			await page.eval(fill("#wz-ownerPassword", "correct horse battery"));
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-orgName")`);
			await page.eval(fill("#wz-orgName", "Logical"));
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-wildcard")`);
			await page.eval(fill("#wz-wildcard", "srv1.logical.it"));
		},
	},
	{
		name: "home",
		path: "/",
		ready: `document.querySelectorAll("table tbody tr").length > 3`,
	},
	{
		name: "projects",
		path: "/projects",
		ready: `document.querySelectorAll('main a[href^="/projects/prj"]').length > 3`,
	},
	{
		name: "project-detail",
		path: "/projects/prj_storefront",
		ready: `document.querySelectorAll("main ul li").length > 2`,
	},
	{
		name: "new-service-wizard",
		path: "/projects/prj_storefront/services/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-repository")`);
			await page.eval(
				fill("#wz-repository", "github.com/acme-retail/storefront"),
			);
			await page.eval(submit);
			await waitFor(
				page,
				`[...document.querySelectorAll("button")].some(b => b.textContent.includes("Test connection"))`,
			);
			await page.eval(
				`[...document.querySelectorAll("button")].find(b => b.textContent.includes("Test connection")).click()`,
			);
			await waitFor(page, `document.body.textContent.includes("Test again")`);
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
					await waitFor(page, shot.ready);
					await shot.steps?.(page);
					await sleep(900);
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
