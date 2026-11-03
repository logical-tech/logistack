/**
 * Captures the object storage screens into docs/screenshots/storage/, light and dark,
 * at 1440 and 390 px wide.
 *
 *   VITE_API_MOCK=1 bunx vite --port 5197 &
 *   bun scripts/screenshots-storage.ts [baseUrl] [shot-name-filter]
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
	submit,
	waitFor,
} from "./cdp";

const BASE = process.argv[2] ?? "http://localhost:5197";
const ONLY = process.argv[3];
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "storage");
const PORT = 9337;
const MEDIA =
	"/projects/prj_storefront/services/svc_storefront_production_media/storage";

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

const hasText = (text: string) =>
	`document.body.textContent.includes(${JSON.stringify(text)})`;
const dialog = `!!document.querySelector('[role="dialog"]')`;

/** Radix menus open on pointerdown, not click. */
const openMenu = (label: string) => `(() => {
	const el = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)});
	if (!el) throw new Error(${JSON.stringify(`no menu ${label}`)});
	el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
	return true;
})()`;

/** Drops files on the browser; sizes are spoofed so the mock's progress runs for seconds. */
const dropFiles = (files: [string, string, number][]) => `(() => {
	const dt = new DataTransfer();
	for (const [name, type, size] of ${JSON.stringify(files)}) {
		const f = new File(["x"], name, { type });
		Object.defineProperty(f, "size", { value: size });
		dt.items.add(f);
	}
	const target = document.querySelector('section[aria-label^="Objects in"]');
	for (const type of ["dragenter", "drop"])
		target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
	return true;
})()`;

type Shot = {
	name: string;
	path: string;
	ready: string;
	steps?: (page: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
	{
		name: "engine-picker",
		path: "/projects/prj_storefront/services/new?env=env_storefront_production",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await page.eval(clickText('[role="radio"]', "Object storage"));
			await page.eval(submit);
			await waitFor(page, hasText("Choose an engine"));
			await waitFor(page, `!!document.querySelector('[aria-label="Engine"]')`);
		},
	},
	{
		name: "public-access",
		path: "/projects/prj_storefront/services/new?env=env_storefront_production",
		ready: `!!document.querySelector('[role="radiogroup"]')`,
		steps: async (page) => {
			await page.eval(clickText('[role="radio"]', "Object storage"));
			await page.eval(submit);
			await waitFor(page, `!!document.querySelector('[aria-label="Engine"]')`);
			await page.eval(submit);
			await waitFor(page, hasText("S3 endpoint"));
			await page.eval(
				clickText('[aria-label="S3 endpoint domain"] button', "Generated"),
			);
		},
	},
	{
		name: "browser",
		path: `${MEDIA}?bucket=product-images&prefix=products%2Fchairs%2F`,
		ready: hasText("oak-lounge-chair.jpg"),
	},
	{
		name: "browser-paginated",
		path: `${MEDIA}?bucket=product-images&prefix=thumbnails%2F`,
		ready: hasText("Load more"),
	},
	{
		name: "preview",
		path: `${MEDIA}?bucket=product-images&prefix=products%2Fchairs%2F`,
		ready: hasText("oak-lounge-chair.jpg"),
		steps: async (page) => {
			await page.eval(clickText("tbody button", "walnut-lounge-chair.jpg"));
			await waitFor(page, `!!document.querySelector('[role="dialog"] img')`);
		},
	},
	{
		name: "upload-progress",
		path: `${MEDIA}?bucket=user-uploads&prefix=videos%2F`,
		ready: hasText("unboxing-oak-lounge-chair.mp4"),
		steps: async (page) => {
			await page.eval(
				dropFiles([
					["showroom-tour-4k.mp4", "video/mp4", 1.6 * 1024 ** 3],
					["assembly-guide.mp4", "video/mp4", 420 * 1024 ** 2],
					["walnut-detail-01.jpg", "image/jpeg", 6.2 * 1024 ** 2],
					["walnut-detail-02.jpg", "image/jpeg", 5.8 * 1024 ** 2],
					["return-label.pdf", "application/pdf", 180 * 1024],
				]),
			);
			await waitFor(
				page,
				`!!document.querySelector('section[aria-label="Uploads"]')`,
			);
			await sleep(2600);
		},
	},
	{
		name: "share-dialog",
		path: `${MEDIA}?bucket=product-images&prefix=products%2Fchairs%2F`,
		ready: hasText("oak-lounge-chair.jpg"),
		steps: async (page) => {
			await page.eval(openMenu("Actions for walnut-lounge-chair.jpg"));
			await waitFor(page, `!!document.querySelector('[role="menu"]')`);
			await page.eval(clickText('[role="menuitem"]', "Share link"));
			await waitFor(page, dialog);
			await page.eval(clickText('[role="dialog"] button', "Create link"));
			await waitFor(page, hasText("Expires "), 6000);
		},
	},
	{
		name: "bucket-settings",
		path: `${MEDIA}?bucket=static-assets`,
		ready: hasText("favicon.svg"),
		steps: async (page) => {
			await page.eval(
				`document.querySelector('button[aria-label="Settings for static-assets"]').click()`,
			);
			await waitFor(page, dialog);
		},
	},
	{
		name: "bucket-settings-garage",
		path: "/projects/prj_rossi/services/svc_rossi_production_uploads/storage",
		ready: hasText("projects"),
		steps: async (page) => {
			await page.eval(
				`document.querySelector('button[aria-label="Settings for cms-media"]').click()`,
			);
			await waitFor(page, dialog);
		},
	},
	{
		name: "access-keys",
		path: `${MEDIA}?view=keys`,
		ready: hasText("analytics export"),
	},
	{
		name: "access-key-created",
		path: `${MEDIA}?view=keys`,
		ready: hasText("analytics export"),
		steps: async (page) => {
			await page.eval(clickText("main button", "New access key"));
			await waitFor(page, `!!document.querySelector("#key-name")`);
			await page.eval(`(() => {
				const el = document.querySelector("#key-name");
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "invoice worker");
				el.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			})()`);
			await waitFor(
				page,
				`!!document.querySelector("#key-bucket-user-uploads")`,
			);
			await page.eval(
				`document.querySelector("#key-bucket-user-uploads").click()`,
			);
			await page.eval(clickText('[role="dialog"] button', "Create key"));
			await waitFor(page, hasText("Copy the secret now"), 6000);
		},
	},
	{
		name: "connection",
		path: `${MEDIA}?view=connection`,
		ready: hasText("Root credentials"),
		steps: (page) => waitFor(page, hasText("AWS_SECRET_ACCESS_KEY=••••")),
	},
	{
		name: "connection-locked",
		path: "/projects/prj_llm-gateway/services/svc_llm-gateway_staging_datasets/storage?view=connection",
		ready: hasText("Hidden for your role"),
	},
	{
		name: "storage-list",
		path: "/storage",
		ready: hasText("RustFS"),
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
