/**
 * Prints the MCP tools `/mcp` exposes, generated from the OpenAPI registry, without a database.
 *
 *   bun apps/server/scripts/mcp-tools.ts
 */
import { createApp } from "../src/app.ts";
import type { Deps } from "../src/env.ts";
import { toolsFrom } from "../src/mcp.ts";

const app = createApp({
	config: { WEB_ORIGIN: "http://localhost", WEB_DIST_DIR: "/nonexistent" },
} as Deps);
const tools = toolsFrom(
	app.getOpenAPI31Document({
		openapi: "3.1.0",
		info: { title: "LogiStack API", version: "0.1.0" },
	}) as Parameters<typeof toolsFrom>[0],
);
for (const t of tools)
	console.log(
		`${t.destructive ? "!" : t.method === "get" ? " " : "+"} ${t.name.padEnd(32)} ${t.method.toUpperCase()} ${t.path}`,
	);
console.log(
	`${tools.length} tools, ${tools.filter((t) => t.destructive).length} destructive`,
);
