import { join } from "node:path";
import { createPlugin, type PluginEnv } from "@logistack/plugin-sdk";
import { Hono } from "hono";
import { manifest } from "./manifest.ts";

// The smallest plugin that shows every moving part once installed: a sidebar page in the sandbox,
// the page bridge (viewer, theme, storage, toast), its own backend behind the session token,
// its settings read with its own key, and a tool the Agent can call.

export { manifest };

type Config = { greeting?: string };

const client = await Bun.build({
	entrypoints: [join(import.meta.dir, "page.ts")],
	target: "browser",
	minify: true,
});
const pageJs = (await client.outputs[0]?.text()) ?? "";
const css = await Bun.file(
	Bun.resolveSync("@logistack/plugin-sdk/ui.css", import.meta.dir),
).text();

const ui = new Hono<PluginEnv>()
	.get("/hello", (c) =>
		c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hello</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./assets/ui.css"><link rel="stylesheet" href="./assets/hello.css"></head>
<body><main id="root" class="ls-empty">Loading…</main>
<script type="module" src="./assets/page.js"></script></body></html>`),
	)
	.get("/assets/page.js", (c) =>
		c.body(pageJs, 200, { "content-type": "text/javascript" }),
	)
	.get("/assets/ui.css", (c) =>
		c.body(css, 200, { "content-type": "text/css" }),
	)
	.get("/assets/hello.css", (c) =>
		c.body(HELLO_CSS, 200, { "content-type": "text/css" }),
	)
	// The page's own backend: the viewer arrives signed by LogiStack, the greeting from settings.
	.get("/api/greeting", async (c) => {
		const config = await c.get("ctx").logistack.config<Config>();
		return c.json({
			greeting: config.greeting?.trim() || "Hello",
			name: c.get("user").name,
		});
	});

export const app = createPlugin({
	manifest,
	ui,
	tools: {
		async "say-hello"(input, ctx) {
			const { name } = input as { name: string };
			const config = await ctx.logistack.config<Config>();
			return { message: `${config.greeting?.trim() || "Hello"}, ${name}!` };
		},
	},
});

const HELLO_CSS = `
.hello { display: grid; place-items: center; gap: 16px; padding: 48px 16px; text-align: center; }
.hello h1 { font-size: 28px; margin: 0; }
.hand { width: 72px; height: 72px; transform-origin: 70% 75%; animation: wave 1.8s ease-in-out 1; color: var(--foreground); }
@keyframes wave {
	0%, 60%, 100% { transform: rotate(0deg); }
	10%, 30% { transform: rotate(14deg); }
	20% { transform: rotate(-8deg); }
	40% { transform: rotate(-4deg); }
	50% { transform: rotate(10deg); }
}
.count { font-variant-numeric: tabular-nums; font-size: 40px; font-weight: 600; letter-spacing: -0.02em; }
@media (prefers-reduced-motion: reduce) { .hand { animation: none; } }
`;

if (import.meta.main) {
	Bun.serve({
		port: Number(process.env.PORT ?? manifest.port),
		fetch: app.fetch,
	});
	console.log(
		`${manifest.id} listening on ${process.env.PORT ?? manifest.port}`,
	);
}
