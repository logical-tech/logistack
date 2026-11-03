/**
 * Captures docs/screenshots/monitoring/: the Monitoring overview, a node, alerts, the
 * nodes list, a service's Metrics tab and every Add-server step, in light and dark at
 * 1440 and 390 px wide, against the mock API (five nodes, generated 24 h series).
 *
 *   VITE_API_MOCK=1 bun run dev -- --port 5199 &
 *   bun scripts/screenshots-monitoring.ts [baseUrl]
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
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "monitoring");
const PORT = Number(process.env.CDP_PORT ?? 9347);

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

const charts = (n: number) =>
	`document.querySelectorAll("figure .recharts-surface").length >= ${n}`;
const hasText = (t: string) =>
	`document.body.textContent.includes(${JSON.stringify(t)})`;

async function serverStep(page: Page) {
	await waitFor(page, `!!document.querySelector("#wz-name")`);
	await page.eval(fill("#wz-name", "fra-5"));
	await page.eval(fill("#wz-host", "49.12.88.52"));
	await page.eval(clickText("button[aria-pressed]", "ingress"));
	await waitFor(page, hasText("authorized_keys"));
}
async function sshStep(page: Page) {
	await serverStep(page);
	await page.eval(submit);
	await waitFor(page, hasText("runs nothing but a handshake"));
	await page.eval(clickText("form button", "Test connection"));
	await waitFor(page, hasText("Test again"), 10_000);
}
async function preflightStep(page: Page) {
	await sshStep(page);
	await page.eval(submit);
	await waitFor(page, hasText("Run checks"));
	await page.eval(clickText("form button", "Run checks"));
	await waitFor(page, hasText("Ready, with"), 10_000);
}
async function bootstrapStep(page: Page) {
	await preflightStep(page);
	await page.eval(submit);
	await waitFor(page, hasText("Start bootstrap"));
	await page.eval(clickText("form button", "Start bootstrap"));
	await waitFor(page, hasText("joined the cluster"), 15_000);
}

type Shot = {
	name: string;
	path: string;
	ready: string;
	steps?: (p: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
	{ name: "overview", path: "/monitoring", ready: charts(4) },
	{
		name: "overview-per-node",
		path: "/monitoring?view=nodes&range=6h",
		ready: charts(4),
	},
	{
		name: "node-detail",
		path: "/monitoring/nodes/node_fra2",
		ready: charts(4),
	},
	{ name: "nodes", path: "/monitoring/nodes", ready: hasText("fra-4-data") },
	{ name: "alerts", path: "/monitoring/alerts", ready: hasText("Raw samples") },
	{
		name: "service-metrics",
		path: "/projects/prj_storefront/services/svc_storefront_production_web/metrics",
		ready: charts(5),
	},
	{
		name: "add-server-1-server",
		path: "/monitoring/nodes/new",
		ready: "true",
		steps: serverStep,
	},
	{
		name: "add-server-2-ssh",
		path: "/monitoring/nodes/new",
		ready: "true",
		steps: sshStep,
	},
	{
		name: "add-server-3-preflight",
		path: "/monitoring/nodes/new",
		ready: "true",
		steps: preflightStep,
	},
	{
		name: "add-server-4-bootstrap",
		path: "/monitoring/nodes/new",
		ready: "true",
		steps: bootstrapStep,
	},
	{
		name: "add-server-5-done",
		path: "/monitoring/nodes/new",
		ready: "true",
		steps: async (page) => {
			await bootstrapStep(page);
			await page.eval(submit);
			await waitFor(page, hasText("is part of the cluster"));
		},
	},
];

const only = process.env.ONLY?.split(",");

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
					if (only && !only.includes(shot.name)) continue;
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
					await waitFor(page, shot.ready, 10_000);
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
