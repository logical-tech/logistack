/**
 * Screenshots of the host settings (published ports, bind mounts, user, capabilities,
 * restart) in the new-service wizard's Advanced section and on a service's Settings tab,
 * in light and dark at 1440 and 390 px, into docs/screenshots/host-settings/.
 *
 *   VITE_API_MOCK=1 bun run dev -- --port 5199 &
 *   bun scripts/screenshots-host-settings.ts [baseUrl] [--port 9336]
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
	waitFor,
} from "./cdp";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const PORT = Number(flag("--port") ?? 9336);
const BASE = args[0] ?? "http://localhost:5199";
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "host-settings");
const ENV = "env_booking_production";
const SERVICE = "/projects/prj_booking/services/svc_booking_production_search";

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

const has = (selector: string) =>
	`!!document.querySelector(${JSON.stringify(selector)})`;
const click = (selector: string) =>
	`document.querySelector(${JSON.stringify(selector)}).click(); true`;

/** A factorio server: UDP published on its node, its saves from the host, one unconfirmed sensitive path. */
const wizardAnswers = {
	kind: "image",
	image: "factoriotools/factorio:2.0.55",
	port: "27015",
	domainMode: "none",
	host: {
		ports: [{ target: 34197, published: 34197, protocol: "udp" }],
		mounts: [
			{ kind: "bind", hostPath: "/srv/factorio", target: "/factorio" },
			{
				kind: "bind",
				hostPath: "/var/run/docker.sock",
				target: "/var/run/docker.sock",
				readOnly: true,
			},
		],
		user: "845:845",
		capDrop: ["ALL"],
		capAdd: ["NET_BIND_SERVICE"],
		restart: "on-failure",
	},
};

type Shot = {
	name: string;
	path: string;
	ready: string;
	before?: string;
	steps?: (p: Page) => Promise<void>;
	/** Capture from this section to that one instead of the whole page, which runs past 2600 px. */
	clip?: [string, string];
};

const shots: Shot[] = [
	{
		name: "wizard-advanced",
		path: `/projects/prj_booking/services/new?env=${ENV}&step=configure`,
		before: `sessionStorage.setItem("wizard:new-service:${ENV}", ${JSON.stringify(JSON.stringify(wizardAnswers))}); true`,
		ready: has("#mount-1-sensitive"),
	},
	{
		name: "settings-host",
		path: `${SERVICE}/settings`,
		ready: has("#host"),
		steps: async (page) => {
			await page.eval(clickText("button", "Add port"));
			await waitFor(page, has('input[aria-label="Container port 2"]'));
			await page.eval(fill('input[aria-label="Container port 2"]', "7701"));
			await page.eval(fill('input[aria-label="Published port 2"]', "7701"));
			await page.eval(click('[aria-label="Protocol 2"] button:last-child'));
			await page.eval(clickText("button", "Add bind mount"));
			await waitFor(page, has('input[aria-label="Host path 1"]'));
			await page.eval(fill('input[aria-label="Host path 1"]', "/etc"));
			await page.eval(fill('input[aria-label="Container path 1"]', "/host"));
			await page.eval(fill("#host-user", "1000:1000"));
		},
		clip: ["#runtime", "#host"],
	},
];

async function captureBetween(
	page: Page,
	file: string,
	vp: (typeof VIEWPORTS)[number],
	[from, to]: [string, string],
) {
	const box = (await page.eval(`(() => {
		const top = document.querySelector(${JSON.stringify(from)}).closest("section").getBoundingClientRect().top + scrollY;
		const bottom = document.querySelector(${JSON.stringify(to)}).closest("section").getBoundingClientRect().bottom + scrollY;
		return { top, bottom, height: document.documentElement.scrollHeight };
	})()`)) as { top: number; bottom: number; height: number };
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: vp.width,
		height: box.height,
		deviceScaleFactor: vp.mobile ? 2 : 1,
		mobile: vp.mobile,
	});
	await sleep(300);
	const { data } = await page.send("Page.captureScreenshot", {
		format: "png",
		clip: {
			x: 0,
			y: box.top - 32,
			width: vp.width,
			height: box.bottom - box.top + 64,
			scale: 1,
		},
	});
	if (!data) throw new Error(`no screenshot for ${file}`);
	await Bun.write(file, Buffer.from(data, "base64"));
}

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
					if (shot.before) await page.eval(shot.before);
					await page.send("Page.navigate", { url: `${BASE}${shot.path}` });
					await waitFor(page, shot.ready);
					await shot.steps?.(page);
					await sleep(900);
					const file = join(OUT, `${shot.name}-${theme}-${vp.name}.png`);
					if (shot.clip) await captureBetween(page, file, vp, shot.clip);
					else await capture(page, file, vp);
					console.log(`saved ${file}`);
				}
			}
		}
	} finally {
		await chrome.close();
	}
}

await main();
