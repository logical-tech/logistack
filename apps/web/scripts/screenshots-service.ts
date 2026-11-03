/**
 * Captures docs/screenshots/service/: every tab of a service page, a selected deployment's
 * log, a log search and a terminal after a command, in light and dark at 1440 and 390 px
 * wide, against the real API (vite with VITE_API_MOCK=0, the server, worker and an agent).
 * Signs in through the real sign-in page.
 *
 *   bun scripts/screenshots-service.ts [baseUrl] [projectId] [serviceId]
 *   LS_EMAIL=… LS_PASSWORD=… ONLY=terminal,logs bun scripts/screenshots-service.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	connect,
	fill,
	launchChrome,
	type Page,
	sleep,
	submit,
	waitFor,
} from "./cdp";

const BASE = process.argv[2] ?? "http://localhost:5173";
const PROJECT = process.argv[3] ?? "prj_qg18amby9q2zw8cg22qcpte7";
const SERVICE = process.argv[4] ?? "svc_pea8jcbkq8t96py53t0e4bbh";
const EMAIL = process.env.LS_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.LS_PASSWORD ?? "correct horse battery";
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "service");
const PORT = Number(process.env.CDP_PORT ?? 9353);
const PAGE = `/projects/${PROJECT}/services/${SERVICE}`;

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

const hasText = (t: string) =>
	`document.body.textContent.includes(${JSON.stringify(t)})`;
const has = (selector: string) =>
	`!!document.querySelector(${JSON.stringify(selector)})`;
const logLines = (n: number) =>
	`document.querySelectorAll('[role=log] [data-index]').length >= ${n}`;

async function key(page: Page, text: string, code: string, keyCode: number) {
	for (const type of ["keyDown", "keyUp"])
		await page.send("Input.dispatchKeyEvent", {
			type,
			key: text === "\r" ? "Enter" : text,
			code,
			windowsVirtualKeyCode: keyCode,
			...(type === "keyDown" ? { text } : {}),
		});
}

type Shot = {
	name: string;
	path: string;
	ready: string;
	/** Capture the viewport, not the full page: the log and the terminal size to the screen. */
	fixed?: boolean;
	steps?: (p: Page) => Promise<void>;
};

function shots(deploymentId: string): Shot[] {
	return [
		{ name: "overview", path: PAGE, ready: has("#replicas") },
		{
			name: "deployments",
			path: `${PAGE}/deployments?d=${deploymentId}`,
			ready: logLines(1),
			fixed: true,
		},
		{
			name: "logs",
			path: `${PAGE}/logs?since=all`,
			ready: logLines(5),
			fixed: true,
		},
		{
			name: "logs-search",
			path: `${PAGE}/logs?since=all`,
			ready: logLines(5),
			fixed: true,
			steps: async (page) => {
				await page.eval(fill('input[aria-label="Search output"]', "GET /"));
				await waitFor(page, has("[role=log] mark"));
				await page.eval(
					`document.querySelector('button[aria-label="Previous match"]').click()`,
				);
			},
		},
		{
			name: "terminal",
			path: `${PAGE}/terminal`,
			ready: hasText("Connected"),
			fixed: true,
			steps: async (page) => {
				await page.eval(
					`document.querySelector(".xterm-helper-textarea").focus()`,
				);
				await page.send("Input.insertText", {
					text: "nginx -v; ls --color=always /etc/nginx; uname -sr",
				});
				await key(page, "\r", "Enter", 13);
				await waitFor(page, hasText("mime.types"));
			},
		},
		{
			name: "environment",
			path: `${PAGE}/environment`,
			ready: has("#service-vars"),
		},
		{
			name: "domains",
			path: `${PAGE}/domains`,
			ready: `${has("table[aria-label=Domains]")} || ${hasText("No public address")}`,
		},
		{
			name: "metrics",
			path: `${PAGE}/metrics`,
			ready: `document.querySelectorAll("figure .recharts-surface").length >= 5`,
		},
		{
			name: "settings",
			path: `${PAGE}/settings`,
			ready: hasText("Danger zone"),
		},
		{
			name: "backups",
			path: `${PAGE}/backups`,
			ready: hasText("backs up web yet"),
		},
	];
}

const only = process.env.ONLY?.split(",");

async function signIn(page: Page) {
	await page.send("Page.navigate", { url: `${BASE}/sign-in` });
	await waitFor(page, has("#email"), 15_000);
	await page.eval(fill("#email", EMAIL));
	await page.eval(fill("#password", PASSWORD));
	await page.eval(submit);
	await waitFor(page, `location.pathname === "/"`, 15_000);
}

async function capture(
	page: Page,
	file: string,
	vp: (typeof VIEWPORTS)[number],
	fixed: boolean,
) {
	const scale = vp.mobile ? 2 : 1;
	const height = fixed
		? vp.height
		: Math.min(
				Math.max(
					Number(await page.eval("document.documentElement.scrollHeight")),
					vp.height,
				),
				2600,
			);
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: vp.width,
		height,
		deviceScaleFactor: scale,
		mobile: vp.mobile,
	});
	await sleep(300);
	const { data } = await page.send("Page.captureScreenshot", { format: "png" });
	if (!data) throw new Error(`no screenshot for ${file}`);
	await Bun.write(file, Buffer.from(data, "base64"));
}

async function main() {
	await mkdir(OUT, { recursive: true });
	const chrome = await launchChrome(PORT);
	try {
		const first = await connect(PORT);
		await first.send("Page.enable");
		await signIn(first);
		const [latest] = (await first.eval(
			`fetch("/api/services/${SERVICE}/deployments?limit=1", { credentials: "include" }).then((r) => r.json())`,
		)) as { id: string }[];
		if (!latest) throw new Error(`${SERVICE} has no deployment to show`);

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
				for (const shot of shots(latest.id)) {
					if (only && !only.includes(shot.name)) continue;
					await page.send("Emulation.setDeviceMetricsOverride", {
						width: vp.width,
						height: vp.height,
						deviceScaleFactor: vp.mobile ? 2 : 1,
						mobile: vp.mobile,
					});
					await page.send("Page.navigate", { url: `${BASE}/sign-in` });
					await sleep(300);
					await page.eval(`localStorage.setItem("ls-theme", "${theme}"); true`);
					await page.send("Page.navigate", { url: `${BASE}${shot.path}` });
					await waitFor(page, shot.ready, 15_000);
					await shot.steps?.(page);
					await sleep(900);
					const file = join(OUT, `${shot.name}-${theme}-${vp.name}.png`);
					await capture(page, file, vp, shot.fixed ?? false);
					console.log(`saved ${file}`);
				}
			}
		}
	} finally {
		await chrome.close();
	}
}

await main();
