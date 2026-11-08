#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLUGIN_MANIFEST_LABEL } from "@logistack/contracts";
import { contractTest } from "./testing.ts";

// logistack-plugin: init, dev, test and build for plugin authors (docs/plans/plugins.md, "SDK").

const usage = `logistack-plugin <command>

  init <dir> --id com.acme.my-plugin   Scaffold a plugin
  dev [entry]                          Run the plugin locally with a dev signing secret
  test <url> --secret <s>              Run the contract test against a running plugin
  build <tag> [entry]                  docker build, with the manifest as the image label
`;

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

async function loadManifest(entry: string) {
	const mod = (await import(resolve(entry))) as { manifest?: unknown };
	if (!mod.manifest)
		throw new Error(`${entry} must export \`manifest\` (from defineManifest)`);
	return mod.manifest as { id: string; port: number };
}

const files = (id: string): Record<string, string> => ({
	"package.json": `${JSON.stringify(
		{
			name: id.split(".").at(-1),
			private: true,
			type: "module",
			scripts: { dev: "logistack-plugin dev", start: "bun src/main.ts" },
			dependencies: { "@logistack/plugin-sdk": "^0.1.0" },
		},
		null,
		"\t",
	)}\n`,
	"src/manifest.ts": `import { defineManifest } from "@logistack/plugin-sdk";

export const manifest = defineManifest({
	id: "${id}",
	version: "0.1.0",
	name: "${id.split(".").at(-1)}",
	description: "",
	permissions: ["read"],
	contributes: {
		events: ["deployment.failed"],
		pages: [{ id: "home", title: "Home", location: "sidebar", path: "/ui/home" }],
	},
});
`,
	"src/main.ts": `import { createPlugin } from "@logistack/plugin-sdk";
import { Hono } from "hono";
import { manifest } from "./manifest.ts";

export { manifest };

const ui = new Hono();
ui.get("/home", (c) => c.html(\`<!doctype html><link rel="stylesheet" href="./ui.css"><h1>Hello</h1>
<script type="module" src="./page.js"></script>\`));

export const app = createPlugin({
	manifest,
	onEvent: (event) => console.log("event", event.type, event.resource),
	ui,
});

if (import.meta.main) Bun.serve({ port: manifest.port, fetch: app.fetch });
`,
	Dockerfile: `FROM oven/bun:1.4-alpine
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY src ./src
USER bun
CMD ["bun", "src/main.ts"]
`,
});

async function main(args: string[]) {
	const [cmd, ...rest] = args;
	switch (cmd) {
		case "init": {
			const dir = rest[0];
			const id = flag(rest, "id");
			if (!dir || !id) throw new Error("init <dir> --id com.acme.my-plugin");
			if (existsSync(dir)) throw new Error(`${dir} exists`);
			for (const [path, content] of Object.entries(files(id))) {
				const full = join(dir, path);
				mkdirSync(join(full, ".."), { recursive: true });
				writeFileSync(full, content);
			}
			console.log(
				`Created ${dir}. Next: cd ${dir} && bun install && bun run dev`,
			);
			return;
		}
		case "dev": {
			const entry = rest[0] ?? "src/main.ts";
			const manifest = await loadManifest(entry);
			const secret =
				process.env.LOGISTACK_SIGNING_SECRET ??
				Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString(
					"base64url",
				);
			console.log(`${manifest.id} on http://localhost:${manifest.port}
Install it in LogiStack with Settings → Plugins → Install from URL, then restart this with
the LOGISTACK_TOKEN and LOGISTACK_SIGNING_SECRET the wizard shows. Until then the secret is:
  ${secret}`);
			const p = Bun.spawn(["bun", "--watch", entry], {
				env: { ...process.env, LOGISTACK_SIGNING_SECRET: secret },
				stdio: ["inherit", "inherit", "inherit"],
			});
			process.exit(await p.exited);
			return;
		}
		case "test": {
			const url = rest[0];
			const secret =
				flag(rest, "secret") ?? process.env.LOGISTACK_SIGNING_SECRET;
			if (!url || !secret)
				throw new Error("test <url> --secret <signing secret>");
			const { checks } = await contractTest(url, secret);
			for (const c of checks)
				console.log(
					`${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`,
				);
			process.exit(checks.every((c) => c.ok) ? 0 : 1);
			return;
		}
		case "build": {
			const tag = rest[0];
			if (!tag) throw new Error("build <tag> [entry]");
			const manifest = await loadManifest(rest[1] ?? "src/main.ts");
			const p = Bun.spawn(
				[
					"docker",
					"build",
					"--label",
					`${PLUGIN_MANIFEST_LABEL}=${JSON.stringify(manifest)}`,
					"-t",
					tag,
					".",
				],
				{ stdio: ["inherit", "inherit", "inherit"] },
			);
			process.exit(await p.exited);
			return;
		}
		default:
			console.log(usage);
			process.exit(cmd ? 1 : 0);
	}
}

if (import.meta.main)
	await main(process.argv.slice(2)).catch((e: unknown) => {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	});
