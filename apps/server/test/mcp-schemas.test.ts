import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { createApp } from "../src/app.ts";
import type { Deps } from "../src/env.ts";
import { type OpenApiDoc, toolsFrom } from "../src/mcp.ts";

// Building the OpenAPI document touches no dependency, so no database is needed.
const app = createApp({
	config: { WEB_ORIGIN: "http://localhost", WEB_DIST_DIR: "/nonexistent" },
} as unknown as Deps);
const doc = app.getOpenAPI31Document({
	openapi: "3.1.0",
	info: { title: "t", version: "0" },
}) as OpenApiDoc;
const tools = toolsFrom(doc);

describe("MCP tool input schemas", () => {
	test("every tool has a valid JSON Schema with unique required items", () => {
		expect(tools.length).toBeGreaterThan(100);
		const ajv = new Ajv2020({ strict: false, validateFormats: false });
		const bad: string[] = [];
		for (const t of tools) {
			if (!ajv.validateSchema(t.inputSchema))
				bad.push(`${t.name}: ${ajv.errorsText(ajv.errors)}`);
			const required = (t.inputSchema.required ?? []) as string[];
			if (new Set(required).size !== required.length)
				bad.push(`${t.name}: duplicate required ${required}`);
			for (const r of required)
				if (!(r in (t.inputSchema.properties ?? {})))
					bad.push(`${t.name}: required ${r} has no property`);
		}
		expect(bad).toEqual([]);
	});

	test("storage_bucket_delete takes the bucket name apart from confirm", () => {
		const t = tools.find((x) => x.name === "storage_bucket_delete");
		expect(t?.inputSchema.required).toEqual([
			"id",
			"bucket",
			"confirmName",
			"confirm",
		]);
		expect(t?.queryParams).toEqual(["confirmName"]);
	});

	test("a route parameter named like a tool argument is refused", () => {
		const op = (name: string) => ({
			paths: {
				"/api/x": {
					get: { parameters: [{ name, in: "query" as const, required: true }] },
				},
			},
		});
		expect(() => toolsFrom(op("confirm"))).toThrow("reserved");
		expect(() => toolsFrom(op("body"))).toThrow("reserved");
		expect(toolsFrom(op("q"))[0]?.inputSchema.required).toEqual(["q"]);
	});
});
