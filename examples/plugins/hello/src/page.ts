import { connect } from "@logistack/plugin-sdk/ui";

// Runs in the sandboxed iframe. Everything here is checkable by eye once the plugin is installed.

const root = document.getElementById("root") as HTMLElement;
const page = await connect();

const esc = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(ch) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				ch
			] as string,
	);

// From the plugin's own backend: proves the session token and the signed viewer claims.
const res = await page.api("greeting");
const { greeting, name } = res.ok
	? ((await res.json()) as { greeting: string; name: string })
	: { greeting: "Hello", name: page.init.user.name };

// Kept by LogiStack over the bridge, per user: survives reloads and other browsers.
let count = (await page.storage.get<number>("hellos")) ?? 0;

root.className = "hello";
root.innerHTML = `
	<svg class="hand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M18 11V6a2 2 0 0 0-4 0v1"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/>
		<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
	</svg>
	<h1>${esc(greeting)}, ${esc(name)}!</h1>
	<p class="ls-muted">This page runs inside a sandbox in ${esc(page.init.organization.name)}, in ${page.init.theme} mode.</p>
	<div class="count" id="count" aria-live="polite">${count}</div>
	<p class="ls-muted" id="label">${count === 1 ? "hello so far" : "hellos so far"}</p>
	<button class="ls-button" data-variant="primary" id="wave">Say hello</button>
`;

const countEl = document.getElementById("count") as HTMLElement;
const labelEl = document.getElementById("label") as HTMLElement;
document.getElementById("wave")?.addEventListener("click", async () => {
	count += 1;
	countEl.textContent = String(count);
	labelEl.textContent = count === 1 ? "hello so far" : "hellos so far";
	await page.storage.set("hellos", count);
	page.toast(`${greeting} back, ${name}!`, "success");
});
