/**
 * The sidebar foot (cluster status and version) expanded and collapsed, in light and dark, with
 * the status tooltip open, into docs/screenshots/sidebar/.
 *
 *   VITE_API_MOCK=1 bun run dev -- --port 5199 &
 *   bun scripts/screenshots-sidebar.ts [baseUrl] [--port 9336]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, launchChrome, sleep, waitFor } from "./cdp";

const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const PORT = portAt >= 0 ? Number(args.splice(portAt, 2)[1]) : 9336;
const BASE = args[0] ?? "http://localhost:5199";
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "sidebar");
const VIEWPORT = { width: 1440, height: 900 };
const DOT = `document.querySelector('[data-sidebar=footer] a[href="/monitoring"]')`;

await mkdir(OUT, { recursive: true });
const chrome = await launchChrome(PORT);
try {
	for (const theme of ["light", "dark"] as const) {
		for (const state of ["expanded", "collapsed"] as const) {
			const page = await connect(PORT);
			await page.send("Page.enable");
			await page.send("Emulation.setEmulatedMedia", {
				features: [
					{ name: "prefers-color-scheme", value: theme },
					{ name: "prefers-reduced-motion", value: "reduce" },
				],
			});
			await page.send("Emulation.setDeviceMetricsOverride", {
				...VIEWPORT,
				deviceScaleFactor: 2,
				mobile: false,
			});
			await page.send("Page.navigate", { url: `${BASE}/sign-in` });
			await sleep(400);
			await page.eval(
				`localStorage.setItem("ls-theme", "${theme}"); localStorage.setItem("ls-mock-signed-in", "1"); true`,
			);
			await page.send("Page.navigate", { url: `${BASE}/` });
			await waitFor(
				page,
				`${DOT} && /v\\d/.test(document.querySelector("[data-sidebar=footer]").textContent)`,
			);
			if (state === "collapsed")
				await page.eval(
					`document.querySelector("[data-sidebar=trigger]").click(); true`,
				);
			await sleep(600);
			const box = (await page.eval(
				`(() => { const r = ${DOT}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
			)) as { x: number; y: number };
			await page.send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				...box,
			});
			await sleep(900);
			const shot = await page.send("Page.captureScreenshot", {
				format: "png",
				clip: {
					x: 0,
					y: VIEWPORT.height - 220,
					width: 340,
					height: 220,
					scale: 1,
				},
			});
			const file = join(OUT, `sidebar-${state}-${theme}.png`);
			await writeFile(file, Buffer.from(shot.data as string, "base64"));
			console.log(`saved ${file}`);
		}
	}
} finally {
	await chrome.close();
}
