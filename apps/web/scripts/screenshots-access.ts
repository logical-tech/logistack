/**
 * Screenshots of the access-control screens (members, roles, API keys, account
 * security, audit log, SSH keys) in light and dark at 1440 and 390 px, into
 * docs/screenshots/access/.
 *
 *   VITE_API_MOCK=1 bun run dev -- --port 5199 &
 *   bun scripts/screenshots-access.ts [baseUrl] [--only name,name] [--port 9333]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { capture, connect, launchChrome, sleep, waitFor } from "./cdp";
import { type Shot, shots } from "./shots/access";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const only = flag("--only")?.split(",");
const PORT = Number(flag("--port") ?? 9335);
const BASE = args[0] ?? "http://localhost:5199";
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "access");

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

async function main() {
	await mkdir(OUT, { recursive: true });
	const selected: Shot[] = only
		? shots.filter((s) => only.includes(s.name))
		: shots;
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
				for (const shot of selected) {
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
					await shot.steps?.(page, vp);
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
