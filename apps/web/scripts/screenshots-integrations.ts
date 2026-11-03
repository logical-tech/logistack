/**
 * Captures the Git provider and registry screens into docs/screenshots/integrations/,
 * light and dark, at 1440 and 390 px wide.
 *
 *   VITE_API_MOCK=1 bunx vite --port 5199 &
 *   bun scripts/screenshots-integrations.ts [baseUrl] [shot-name-filter]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	capture,
	clickText,
	connect,
	fill,
	launchChrome,
	type Page,
	sleep,
	submit,
	waitFor,
} from "./cdp";

const BASE = process.argv[2] ?? "http://localhost:5199";
const ONLY = process.argv[3];
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "integrations");
const PORT = 9334;

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

const hasText = (text: string) =>
	`document.querySelector("main")?.textContent.includes(${JSON.stringify(text)})`;

type Shot = {
	name: string;
	path: string;
	ready: string;
	steps?: (page: Page) => Promise<void>;
};

async function toGitHubCreate(page: Page) {
	await page.eval(submit);
	await waitFor(page, `!!document.querySelector("#wz-appName")`);
	await page.eval(fill("#wz-appName", "logistack-acme"));
	await page.eval(submit);
	await waitFor(page, hasText("Create on GitHub"));
}

async function toGitHubInstall(page: Page) {
	await toGitHubCreate(page);
	await page.eval(clickText("button", "Create on GitHub"));
	await waitFor(page, hasText("I've installed it"));
}

async function toGhcrCredentials(page: Page) {
	await page.eval(submit);
	await waitFor(page, `!!document.querySelector("#wz-username")`);
	await page.eval(fill("#wz-username", "acme-ci"));
	await page.eval(fill("#wz-password", "ghp_mockmockmockmockmock"));
	await page.eval(fill("#wz-namespace", "acme-retail"));
}

const SHOTS: Shot[] = [
	{
		name: "git-providers",
		path: "/integrations/git",
		ready: `document.querySelectorAll("table tbody tr").length >= 4`,
	},
	{
		name: "github-1-name",
		path: "/integrations/git/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-appName")`);
			await page.eval(fill("#wz-appName", "logistack-acme"));
		},
	},
	{
		name: "github-2-create",
		path: "/integrations/git/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: toGitHubCreate,
	},
	{
		name: "github-3-install",
		path: "/integrations/git/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: toGitHubInstall,
	},
	{
		name: "github-4-test",
		path: "/integrations/git/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await toGitHubInstall(page);
			await page.eval(clickText("button", "I've installed it"));
			await waitFor(page, hasText("Test connection"));
			await page.eval(clickText("button", "Test connection"));
			await waitFor(page, hasText("Test again"));
		},
	},
	{
		name: "gitlab-credentials",
		path: "/integrations/git/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await page.eval(clickText('[role="radio"]', "GitLab"));
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-token")`);
			await page.eval(fill("#wz-baseUrl", "https://gitlab.logical.it"));
		},
	},
	{
		name: "registries",
		path: "/integrations/registries",
		ready: hasText("Push to"),
	},
	{
		name: "ghcr-1-credentials",
		path: "/integrations/registries/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: toGhcrCredentials,
	},
	{
		name: "ghcr-2-test",
		path: "/integrations/registries/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await toGhcrCredentials(page);
			await page.eval(submit);
			await waitFor(page, hasText("Run test"));
			await page.eval(clickText("button", "Run test"));
			await waitFor(page, hasText("Test again"), 10_000);
		},
	},
	{
		name: "new-service-provider",
		path: "/projects/prj_storefront/services/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-providerId")`);
		},
	},
	{
		name: "new-service-review",
		path: "/projects/prj_storefront/services/new",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-providerId")`);
			await page.eval(`document.querySelector("#wz-repository").click()`);
			await waitFor(page, `!!document.querySelector("[cmdk-item]")`);
			await page.eval(clickText("[cmdk-item]", "acme-retail/checkout"));
			await waitFor(page, hasText("acme-retail/checkout"));
			await page.eval(fill("#wz-watchPaths", "apps/web/**\npackages/ui"));
			await page.eval(submit);
			await waitFor(page, hasText("Test connection"));
			await page.eval(clickText("button", "Test connection"));
			await waitFor(page, hasText("Test again"));
			await page.eval(submit);
			await waitFor(page, hasText("Generated hostname"));
			await page.eval(submit);
			await waitFor(page, hasText("Create and deploy"));
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
					if (ONLY && !shot.name.includes(ONLY)) continue;
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
