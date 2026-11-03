/**
 * Screenshots of the template gallery, a template's "What it creates" step and its
 * settings step, in light and dark at 1440 and 390 px, into docs/screenshots/templates/.
 *
 *   VITE_API_MOCK=1 bun run dev -- --port 5199 &
 *   bun scripts/screenshots-templates.ts [baseUrl] [--port 9337]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { capture, connect, launchChrome, sleep, waitFor } from "./cdp";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const PORT = Number(flag("--port") ?? 9337);
const BASE = args[0] ?? "http://localhost:5199";
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "templates");
const FLOW = "/projects/prj_booking/templates";
const ENV = "env_booking_production";

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

const has = (selector: string) =>
	`!!document.querySelector(${JSON.stringify(selector)})`;

const shots = [
	{
		name: "gallery",
		path: `${FLOW}?env=${ENV}`,
		ready: `document.querySelectorAll("[data-tile] img").length > 6`,
		// The grid runs to 508 tiles; the first screen and a half shows its shape.
		fold: 1.5,
	},
	{
		name: "detail",
		path: `${FLOW}/librechat?env=${ENV}&step=overview`,
		ready: has("#tpl-services"),
	},
	{
		name: "inputs",
		path: `${FLOW}/rallly?env=${ENV}&step=settings`,
		ready: has("input[id^=wz-]"),
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
				for (const shot of shots) {
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
					await sleep(900);
					const file = join(OUT, `${shot.name}-${theme}-${vp.name}.png`);
					if (shot.fold) {
						const height = Math.round(vp.height * shot.fold);
						await page.send("Emulation.setDeviceMetricsOverride", {
							width: vp.width,
							height,
							deviceScaleFactor: vp.mobile ? 2 : 1,
							mobile: vp.mobile,
						});
						await sleep(500);
						const { data } = await page.send("Page.captureScreenshot", {
							format: "png",
						});
						if (!data) throw new Error(`no screenshot for ${file}`);
						await Bun.write(file, Buffer.from(data, "base64"));
					} else await capture(page, file, vp);
					console.log(`saved ${file}`);
				}
			}
		}
	} finally {
		await chrome.close();
	}
}

await main();
