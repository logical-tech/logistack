import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	createPlugin,
	type EventEnvelope,
	type PluginEnv,
	requirePermission,
} from "@logistack/plugin-sdk";
import { Hono } from "hono";
import { manifest } from "./manifest.ts";

// Reference plugin (docs/plans/plugins.md, phase 1): an event hook that posts failed deploys to
// a chat webhook, a sidebar page listing them, and a service tab with that service's own.

export { manifest };

type Config = {
	webhookUrl: string;
	mention?: string;
	includeSucceeded?: boolean;
};
export type Entry = {
	id: string;
	type: EventEnvelope["type"];
	serviceId: string;
	message: string;
	at: string;
	delivered: boolean;
	error?: string;
};

const KEEP = 200;
const dataDir = process.env.DATA_DIR ?? join(import.meta.dir, "..", ".data");
mkdirSync(dataDir, { recursive: true });
const path = join(dataDir, "events.json");

async function load(): Promise<Entry[]> {
	// A fresh handle each time: a BunFile caches its size from the first read.
	const file = Bun.file(path);
	return (await file.exists()) ? ((await file.json()) as Entry[]) : [];
}

// One writer at a time: events can arrive concurrently.
let writing = Promise.resolve();
const append = (e: Entry) => {
	writing = writing.then(async () => {
		const all = await load();
		if (all.some((x) => x.id === e.id)) return;
		await Bun.write(path, JSON.stringify([e, ...all].slice(0, KEEP)));
	});
	return writing;
};

export function messageFor(event: EventEnvelope, config: Config): string {
	const p = event.payload as { serviceName?: string; message?: string };
	const what = p.serviceName ?? event.resource.id;
	const verb = event.type === "deployment.failed" ? "failed" : "succeeded";
	return [
		config.mention,
		`Deploy of ${what} ${verb}`,
		p.message ? `: ${p.message}` : "",
	]
		.filter(Boolean)
		.join(" ")
		.replace(" :", ":");
}

// Bundled once at start, served to the pages; a read-only root is fine, nothing is written.
const client = await Bun.build({
	entrypoints: [join(import.meta.dir, "page.ts")],
	target: "browser",
	minify: true,
});
const pageJs = await client.outputs[0]?.text();
const css = await Bun.file(
	Bun.resolveSync("@logistack/plugin-sdk/ui.css", import.meta.dir),
).text();

const shell = (title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./assets/ui.css"></head>
<body><div id="root" class="ls-empty">Loading…</div>
<script type="module" src="./assets/page.js"></script></body></html>`;

const ui = new Hono<PluginEnv>()
	.get("/failures", (c) => c.html(shell("Deploy alerts")))
	.get("/service", (c) => c.html(shell("Alerts")))
	.get("/assets/page.js", (c) =>
		c.body(pageJs ?? "", 200, { "content-type": "text/javascript" }),
	)
	.get("/assets/ui.css", (c) =>
		c.body(css, 200, { "content-type": "text/css" }),
	)
	.get("/api/events", requirePermission("read"), async (c) => {
		const serviceId = c.get("user").context.serviceId;
		const all = await load();
		return c.json(
			serviceId ? all.filter((e) => e.serviceId === serviceId) : all,
		);
	});

export const app = createPlugin({
	manifest,
	ui,
	tools: {
		async "post-message"(input, ctx) {
			const { text } = input as { text: string };
			const config = await ctx.logistack.config<Config>();
			const res = await fetch(config.webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text: [config.mention, text].filter(Boolean).join(" "),
				}),
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) throw new Error(`the chat webhook answered ${res.status}`);
			return { posted: true };
		},
	},
	validateConfig(config) {
		const url = String(config.webhookUrl ?? "");
		if (!/^https:\/\//.test(url)) return "the webhook URL must be https";
	},
	async onEvent(event, ctx) {
		const config = await ctx.logistack.config<Config>();
		if (event.type === "deployment.succeeded" && !config.includeSucceeded) {
			await append(entry(event, true));
			return;
		}
		const res = await fetch(config.webhookUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: messageFor(event, config) }),
			signal: AbortSignal.timeout(10_000),
		}).catch((e: unknown) => e as Error);
		const ok = !(res instanceof Error) && res.ok;
		await append(
			entry(
				event,
				ok,
				res instanceof Error
					? res.message
					: ok
						? undefined
						: `HTTP ${res.status}`,
			),
		);
		// Throwing makes LogiStack retry the delivery with backoff.
		if (!ok) throw new Error("the chat webhook refused the message");
	},
});

function entry(
	event: EventEnvelope,
	delivered: boolean,
	error?: string,
): Entry {
	const p = event.payload as { message?: string };
	return {
		id: event.id,
		type: event.type,
		serviceId: event.resource.id,
		message: p.message ?? "",
		at: new Date(event.at).toISOString(),
		delivered,
		...(error ? { error } : {}),
	};
}

if (import.meta.main) {
	Bun.serve({
		port: Number(process.env.PORT ?? manifest.port),
		fetch: app.fetch,
	});
	console.log(
		`${manifest.id} listening on ${process.env.PORT ?? manifest.port}`,
	);
}
