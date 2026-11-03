/**
 * Settings > Updates into docs/screenshots/updates/, light and dark, at 1440 and 390 px wide:
 * an update available, the confirmation, a run in progress, a finished run and a rolled-back one.
 *
 *   VITE_API_MOCK=1 bunx vite --port 5198 &
 *   bun scripts/screenshots-updates.ts [baseUrl] [shot-name-filter]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	capture,
	clickText,
	connect,
	launchChrome,
	type Page,
	sleep,
	waitFor,
} from "./cdp";

const BASE = process.argv[2] ?? "http://localhost:5198";
const ONLY = process.argv[3];
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "updates");
const PORT = 9337;

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

const hasText = (text: string) =>
	`document.querySelector("body")?.textContent.includes(${JSON.stringify(text)})`;

async function confirm(page: Page) {
	// The button waits for the signed-in user's role, which loads after the status.
	await waitFor(
		page,
		`[...document.querySelectorAll("button")].some((b) => b.textContent.includes("Update to v0.2.0"))`,
	);
	await page.eval(clickText("button", "Update to v0.2.0"));
	await waitFor(page, `!!document.querySelector('[role="dialog"]')`);
}

async function startRun(page: Page) {
	await confirm(page);
	await page.eval(clickText('[role="dialog"] button', "Update to v0.2.0"));
	await waitFor(page, hasText("v0.1.0 to v0.2.0"));
}

type Shot = {
	name: string;
	fail?: boolean;
	steps?: (page: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
	{ name: "available" },
	{ name: "confirm", steps: confirm },
	{
		name: "running",
		steps: async (page) => {
			await startRun(page);
			await waitFor(page, hasText("logistack_logistack-agent"), 20_000);
		},
	},
	{
		name: "succeeded",
		steps: async (page) => {
			await startRun(page);
			await waitFor(page, hasText("Every service runs v0.2.0"), 30_000);
		},
	},
	{
		name: "rolled-back",
		fail: true,
		steps: async (page) => {
			await startRun(page);
			await waitFor(page, hasText("did not become healthy"), 30_000);
			await page.eval(`document.querySelector("details").open = true; true`);
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
						`localStorage.setItem("ls-theme", "${theme}"); localStorage.setItem("ls-mock-signed-in", "1"); localStorage.setItem("ls-mock-update-fail", "${shot.fail ? 1 : 0}"); true`,
					);
					await page.send("Page.navigate", { url: `${BASE}/settings/updates` });
					await waitFor(page, hasText("What's new in v0.2.0"));
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
