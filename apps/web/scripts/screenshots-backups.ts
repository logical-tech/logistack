/**
 * Captures the S3 destination, backup, restore and schedule screens into
 * docs/screenshots/backups/, light and dark, at 1440 and 390 px wide.
 *
 *   VITE_API_MOCK=1 bunx vite --port 5197 &
 *   bun scripts/screenshots-backups.ts [baseUrl] [shot-name-filter]
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

const BASE = process.argv[2] ?? "http://localhost:5197";
const ONLY = process.argv[3];
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "backups");
const PORT = 9336;
const PG = "svc_storefront_production_postgres";
const BLANK_PG = "svc_booking_production_postgres";

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

const hasText = (text: string) =>
	`document.querySelector("main")?.textContent.includes(${JSON.stringify(text)})`;
const radio = `!!document.querySelector('[role="radiogroup"]')`;

type Shot = {
	name: string;
	path: string;
	ready: string;
	steps?: (page: Page) => Promise<void>;
};

async function toS3Test(page: Page) {
	await page.eval(clickText('[role="radio"]', "Hetzner"));
	await page.eval(submit);
	await waitFor(page, `!!document.querySelector("#wz-bucket")`);
	await page.eval(fill("#wz-bucket", "acme-backups"));
	await page.eval(submit);
	await waitFor(page, `!!document.querySelector("#wz-accessKeyId")`);
	await page.eval(fill("#wz-accessKeyId", "HZ7K2M4Q9R1T5V8X0B3N"));
	await page.eval(fill("#wz-secretAccessKey", "mock-secret-key-0123456789"));
	await page.eval(submit);
	await waitFor(page, hasText("Run test"));
}

async function toRestoreConfirm(page: Page) {
	await page.eval(clickText("main a", "Restore"));
	await waitFor(page, radio);
	await page.eval(submit);
	await waitFor(page, `!!document.querySelector("#wz-newName")`);
	await page.eval(submit);
	await waitFor(page, `!!document.querySelector("#wz-confirm")`);
	// The name to type is the field's own placeholder.
	await page.eval(`(() => {
		const el = document.querySelector("#wz-confirm");
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, el.placeholder);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	})()`);
}

const SHOTS: Shot[] = [
	{
		name: "s3-list",
		path: "/integrations/s3",
		ready: hasText("Backups · R2"),
	},
	{ name: "s3-1-provider", path: "/integrations/s3/new", ready: radio },
	{
		name: "s3-2-test-passed",
		path: "/integrations/s3/new",
		ready: radio,
		steps: async (page) => {
			await toS3Test(page);
			await page.eval(clickText("button", "Run test"));
			await waitFor(page, hasText("Test again"), 10_000);
		},
	},
	{
		name: "s3-delete-refused",
		path: "/integrations/s3",
		ready: hasText("Backups · R2"),
		steps: async (page) => {
			await page.eval(
				`document.querySelector('button[aria-label="Remove Backups · R2"]').click()`,
			);
			await waitFor(page, `!!document.querySelector('[role="dialog"]')`);
			await page.eval(
				clickText('[role="dialog"] button', "Remove destination"),
			);
			await waitFor(
				page,
				`document.querySelector('[role="dialog"]')?.textContent.includes("Still in use")`,
			);
		},
	},
	{
		name: "backups-panel",
		path: `/backups/${PG}`,
		ready: hasText("Recent runs"),
	},
	{
		name: "backups-empty",
		path: `/backups/${BLANK_PG}`,
		ready: hasText("Set up backups"),
	},
	{
		name: "policy-when",
		path: `/backups/${BLANK_PG}/new`,
		ready: radio,
		steps: async (page) => {
			await page.eval(submit);
			await waitFor(page, hasText("Backups · R2"));
			await page.eval(clickText('[role="radio"]', "Backups · R2"));
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-cron")`);
		},
	},
	{
		name: "restore-confirm",
		path: `/backups/${PG}`,
		ready: hasText("Recent runs"),
		steps: toRestoreConfirm,
	},
	{
		name: "restore-progress",
		path: `/backups/${PG}`,
		ready: hasText("Recent runs"),
		steps: async (page) => {
			await toRestoreConfirm(page);
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector('[role="progressbar"]')`);
			await sleep(3200);
		},
	},
	{
		name: "schedules-list",
		path: "/schedules",
		ready: `document.querySelectorAll("table tbody tr").length >= 5`,
	},
	{
		name: "schedule-editor-script",
		path: "/schedules/new",
		ready: `!!document.querySelector("#wz-name")`,
		steps: async (page) => {
			await page.eval(fill("#wz-name", "Nightly VACUUM ANALYZE"));
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-cron")`);
			await page.eval(submit);
			await waitFor(page, radio);
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector(".cm-editor")`);
		},
	},
	{
		name: "schedule-editor-when",
		path: "/schedules/new",
		ready: `!!document.querySelector("#wz-name")`,
		steps: async (page) => {
			await page.eval(fill("#wz-name", "Weekly sales report"));
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-cron")`);
			await page.eval(fill("#wz-cron", "30 9 * * 1-5"));
		},
	},
	{
		name: "schedule-editor-host",
		path: "/schedules/new",
		ready: `!!document.querySelector("#wz-name")`,
		steps: async (page) => {
			await page.eval(fill("#wz-name", "Rotate proxy access logs"));
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector("#wz-cron")`);
			await page.eval(submit);
			await waitFor(page, hasText("On a node's host"));
			await page.eval(clickText('[role="radio"]', "On a node's host"));
			await waitFor(page, hasText("runs as root"));
		},
	},
	{
		name: "schedule-detail",
		path: "/schedules/sch_vacuum",
		ready: hasText("History"),
	},
	{
		name: "schedule-run-live",
		path: "/schedules/sch_vacuum",
		ready: hasText("History"),
		steps: async (page) => {
			await page.eval(clickText("main button", "Run now"));
			await waitFor(page, hasText("Running for"), 6000);
			await sleep(2200);
		},
	},
	{
		name: "schedule-truncated",
		path: "/schedules/sch_report",
		ready: hasText("Truncated at"),
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
