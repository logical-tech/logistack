/** Headless Chrome over the DevTools Protocol, shared by screenshots.ts and e2e.ts. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
	process.env.CHROME ??
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type CdpResult = {
	data?: string;
	result?: { value?: unknown };
	exceptionDetails?: { exception?: { description?: string } };
};
type CdpMessage = {
	id?: number;
	error?: { message: string };
	result?: CdpResult;
};

export type Page = {
	send: (
		method: string,
		params?: Record<string, unknown>,
	) => Promise<CdpResult>;
	eval: (expression: string) => Promise<unknown>;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sets a React-controlled input through the native setter so onChange fires. */
export const fill = (selector: string, value: string) => `(() => {
	const el = document.querySelector(${JSON.stringify(selector)});
	if (!el) throw new Error(${JSON.stringify(`missing ${selector}`)});
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
	Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, ${JSON.stringify(value)});
	el.dispatchEvent(new Event("input", { bubbles: true }));
})()`;

export const submit = `document.querySelector("form button[type=submit]").click()`;

/** Clicks the first element matching `selector` whose text includes `text`. */
export const clickText = (selector: string, text: string) => `(() => {
	const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}));
	if (!el) throw new Error(${JSON.stringify(`no ${selector} with text ${text}`)});
	el.click();
	return true;
})()`;

export async function waitFor(page: Page, expression: string, timeout = 8000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await page.eval(expression)) return;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${expression}`);
}

/** Starts headless Chrome; `close` kills it and removes its profile. */
export async function launchChrome(port: number) {
	const profile = await mkdtemp(join(tmpdir(), "ls-chrome-"));
	const chrome = Bun.spawn(
		[
			CHROME,
			"--headless=new",
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profile}`,
			"--hide-scrollbars",
			"--no-first-run",
			"--font-render-hinting=none",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	const close = async () => {
		chrome.kill();
		await chrome.exited;
		await rm(profile, { recursive: true, force: true });
	};
	for (let i = 0; i < 50; i++) {
		const ok = await fetch(`http://127.0.0.1:${port}/json/version`)
			.then((r) => r.ok)
			.catch(() => false);
		if (ok) return { close };
		await sleep(100);
	}
	await close();
	throw new Error("Chrome did not start");
}

export async function connect(port: number): Promise<Page> {
	const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
		method: "PUT",
	}).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>);
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener("open", r, { once: true }));
	let id = 0;
	const pending = new Map<number, (msg: CdpMessage) => void>();
	ws.addEventListener("message", (e) => {
		const msg = JSON.parse(String(e.data)) as CdpMessage;
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)?.(msg);
			pending.delete(msg.id);
		}
	});
	const send = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<CdpResult>((resolve, reject) => {
			id += 1;
			pending.set(id, (msg) =>
				msg.error
					? reject(new Error(`${method}: ${msg.error.message}`))
					: resolve(msg.result ?? {}),
			);
			ws.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async (expression: string) => {
		const r = await send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (r.exceptionDetails)
			throw new Error(r.exceptionDetails.exception?.description);
		return r.result?.value;
	};
	return { send, eval: evaluate };
}

/** Full-page PNG at the current width, capped at 2600 px tall. */
export async function capture(
	page: Page,
	file: string,
	viewport: { width: number; height: number; mobile?: boolean },
) {
	const scale = viewport.mobile ? 2 : 1;
	const height = Number(
		await page.eval("document.documentElement.scrollHeight"),
	);
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: viewport.width,
		height: Math.min(Math.max(height, viewport.height), 2600),
		deviceScaleFactor: scale,
		mobile: Boolean(viewport.mobile),
	});
	await sleep(300);
	const { data } = await page.send("Page.captureScreenshot", { format: "png" });
	if (!data) throw new Error(`no screenshot for ${file}`);
	await Bun.write(file, Buffer.from(data, "base64"));
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: scale,
		mobile: Boolean(viewport.mobile),
	});
}
