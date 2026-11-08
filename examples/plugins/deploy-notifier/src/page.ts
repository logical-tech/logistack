import { connect } from "@logistack/plugin-sdk/ui";
import type { Entry } from "./main.ts";

// Runs in the sandboxed iframe: everything goes through the bridge or the plugin's own /ui/api.

const root = document.getElementById("root") as HTMLElement;
const esc = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(ch) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				ch
			] as string,
	);

const page = await connect();
const onService = Boolean(page.init.context.serviceId);
let showSucceeded = (await page.storage.get<boolean>("showSucceeded")) ?? false;

async function render() {
	const res = await page.api("events");
	if (!res.ok) {
		root.className = "ls-empty";
		root.textContent = `Could not load alerts (${res.status}).`;
		return;
	}
	const rows = ((await res.json()) as Entry[]).filter(
		(e) => showSucceeded || e.type === "deployment.failed",
	);
	root.className = "ls-stack";
	root.innerHTML = `
		<div class="ls-row" style="justify-content:space-between">
			<div>
				<h1>${onService ? "Deploy alerts for this service" : "Deploy alerts"}</h1>
				<p class="ls-muted">Failed deployments posted to your chat webhook, newest first.</p>
			</div>
			<label class="ls-row ls-muted"><input type="checkbox" id="succ" ${showSucceeded ? "checked" : ""}> Show successful</label>
		</div>
		${
			rows.length
				? `<div class="ls-card" style="padding:0"><table class="ls-table">
			<thead><tr><th>When</th><th>Event</th>${onService ? "" : "<th>Service</th>"}<th>Message</th><th>Chat</th></tr></thead>
			<tbody>${rows
				.map(
					(e) => `<tr>
				<td class="ls-muted">${esc(new Date(e.at).toLocaleString(page.init.locale))}</td>
				<td><span class="ls-badge" data-tone="${e.type === "deployment.failed" ? "bad" : "ok"}">${e.type === "deployment.failed" ? "Failed" : "Succeeded"}</span></td>
				${onService ? "" : `<td><a href="#" data-service="${esc(e.serviceId)}" class="ls-mono">${esc(e.serviceId)}</a></td>`}
				<td>${esc(e.message || "—")}</td>
				<td>${e.delivered ? '<span class="ls-badge" data-tone="ok">Posted</span>' : `<span class="ls-badge" data-tone="warn" title="${esc(e.error ?? "")}">Not posted</span>`}</td>
			</tr>`,
				)
				.join("")}</tbody></table></div>`
				: `<div class="ls-card ls-empty">No deploy alerts yet. They appear here as deployments fail.</div>`
		}`;
	root
		.querySelector<HTMLInputElement>("#succ")
		?.addEventListener("change", async (ev) => {
			showSucceeded = (ev.target as HTMLInputElement).checked;
			await page.storage.set("showSucceeded", showSucceeded);
			void render();
		});
	for (const a of root.querySelectorAll<HTMLAnchorElement>("a[data-service]"))
		a.addEventListener("click", (ev) => {
			ev.preventDefault();
			page.navigate(`/services/${a.dataset.service}`);
		});
}

await render();
