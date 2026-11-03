import type { OpenAPIHono } from "@hono/zod-openapi";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Handler } from "hono";
import { resolveActor } from "./actor.ts";
import { clientIp } from "./audit.ts";
import { API_KEY_PREFIX } from "./auth.ts";
import type { Env } from "./env.ts";

/**
 * `/mcp`: a Model Context Protocol server over Streamable HTTP. Its tools are the
 * OpenAPI operations, one per route, and every call is replayed against the Hono app
 * itself with the caller's API key, so permission checks and the audit trail apply
 * exactly as they do over REST, with the key as the actor.
 */

type JsonSchema = Record<string, unknown>;
type Parameter = {
	name: string;
	in: "path" | "query" | "header" | "cookie";
	required?: boolean;
	description?: string;
	schema?: JsonSchema;
};
type Operation = {
	operationId?: string;
	"x-audit-action"?: string;
	summary?: string;
	description?: string;
	tags?: string[];
	parameters?: Parameter[];
	requestBody?: {
		required?: boolean;
		content?: Record<string, { schema?: JsonSchema }>;
	};
};
type OpenApiDoc = {
	paths?: Record<string, Record<string, Operation>>;
	components?: { schemas?: Record<string, JsonSchema> };
};

export type McpTool = Tool & {
	method: string;
	path: string;
	pathParams: string[];
	queryParams: string[];
	hasBody: boolean;
	destructive: boolean;
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
/** First-run setup is not something an agent with an API key should drive. */
const EXCLUDED_TAGS = new Set(["setup"]);
const DESTRUCTIVE_VERB = /(^|[_/])(stop|restore|rollback)$/;

/** Inlines `#/components/schemas/*` references; MCP clients expect self-contained schemas. */
function deref(
	node: unknown,
	schemas: Record<string, JsonSchema>,
	seen: ReadonlySet<string> = new Set(),
): unknown {
	if (Array.isArray(node)) return node.map((n) => deref(n, schemas, seen));
	if (!node || typeof node !== "object") return node;
	const ref = (node as { $ref?: unknown }).$ref;
	if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
		const name = ref.slice("#/components/schemas/".length);
		// A recursive schema stops at its second occurrence as "any".
		if (seen.has(name) || !schemas[name]) return {};
		return deref(schemas[name], schemas, new Set([...seen, name]));
	}
	return Object.fromEntries(
		Object.entries(node).map(([k, v]) => [k, deref(v, schemas, seen)]),
	);
}

const derivedName = (method: string, path: string) =>
	`${method}_${path
		.split("/")
		.filter(Boolean)
		.map((s) => (s.startsWith("{") ? "by_id" : s))
		.join("_")}`.replace(/[^a-zA-Z0-9_]/g, "_");

/** One tool per OpenAPI operation of the app. */
export function toolsFrom(doc: OpenApiDoc): McpTool[] {
	const schemas = doc.components?.schemas ?? {};
	const tools: McpTool[] = [];
	const names = new Set<string>();
	for (const [apiPath, item] of Object.entries(doc.paths ?? {})) {
		if (!apiPath.startsWith("/api/")) continue;
		const path = apiPath.slice("/api".length);
		for (const method of METHODS) {
			const op = item[method];
			if (!op || op.tags?.some((t) => EXCLUDED_TAGS.has(t))) continue;
			// operationId, else the audit action ("service.create"), else the path; two routes sharing an action fall back to the path.
			const action = op["x-audit-action"]?.replace(".", "_");
			let name = (op.operationId ?? action ?? derivedName(method, path)).slice(
				0,
				60,
			);
			if (names.has(name)) name = derivedName(method, path).slice(0, 60);
			while (names.has(name)) name = `${name}_`;
			names.add(name);
			const properties: Record<string, object> = {};
			const required: string[] = [];
			const params = (op.parameters ?? []).filter(
				(p) => p.in === "path" || p.in === "query",
			);
			for (const p of params) {
				properties[p.name] = {
					...(deref(p.schema ?? {}, schemas) as JsonSchema),
					...(p.description && { description: p.description }),
				};
				if (p.required || p.in === "path") required.push(p.name);
			}
			const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
			if (bodySchema) {
				properties.body = deref(bodySchema, schemas) as JsonSchema;
				if (op.requestBody?.required) required.push("body");
			}
			const destructive =
				method === "delete" ||
				DESTRUCTIVE_VERB.test(path) ||
				DESTRUCTIVE_VERB.test(name);
			if (destructive) {
				properties.confirm = {
					type: "boolean",
					const: true,
					description:
						"Must be true. This operation deletes or stops something; confirm with the user first.",
				};
				required.push("confirm");
			}
			tools.push({
				name,
				title: op.summary,
				description:
					[op.summary, op.description].filter(Boolean).join("\n\n") ||
					`${method.toUpperCase()} ${path}`,
				inputSchema: { type: "object", properties, required },
				annotations: {
					readOnlyHint: method === "get",
					destructiveHint: destructive,
					idempotentHint: method === "get" || method === "delete",
					openWorldHint: false,
				},
				method,
				path,
				pathParams: params.filter((p) => p.in === "path").map((p) => p.name),
				queryParams: params.filter((p) => p.in === "query").map((p) => p.name),
				hasBody: Boolean(bodySchema),
				destructive,
			});
		}
	}
	return tools;
}

const text = (t: string, isError = false) => ({
	content: [{ type: "text" as const, text: t }],
	isError,
});

/** The MCP endpoint over `app`; build it after every route is registered. */
export function mcpHandler(app: OpenAPIHono<Env>): Handler<Env> {
	let tools: McpTool[] | undefined;
	const allTools = () => {
		tools ??= toolsFrom(
			app.getOpenAPI31Document({
				openapi: "3.1.0",
				info: { title: "LogiStack API", version: "0.1.0" },
			}) as OpenApiDoc,
		);
		return tools;
	};

	return async (c) => {
		const bearer = c.req
			.header("authorization")
			?.match(/^Bearer\s+(\S+)$/i)?.[1];
		const unauthorized = (message: string) =>
			c.json({ error: { code: "unauthorized", message } }, 401, {
				"www-authenticate": 'Bearer realm="logistack"',
			});
		// API keys only: a browser session must not be able to drive the API through here.
		if (!bearer?.startsWith(API_KEY_PREFIX))
			return unauthorized("send an API key as Authorization: Bearer lsk_...");
		const actor = await resolveActor(
			c.var.deps,
			new Headers({ authorization: `Bearer ${bearer}` }),
			clientIp(c),
		);
		if (!actor) return unauthorized("invalid, revoked or expired API key");

		const server = new Server(
			{ name: "logistack", version: "0.1.0" },
			{
				capabilities: { tools: {} },
				instructions:
					"LogiStack, a self-hosted PaaS. Tools mirror the REST API one to one and act with this API key's permissions. Destructive tools require `confirm: true`; ask the user before setting it.",
			},
		);
		server.setRequestHandler(ListToolsRequestSchema, () => ({
			tools: allTools().map(
				({
					method: _m,
					path: _p,
					pathParams: _pp,
					queryParams: _qp,
					hasBody: _b,
					destructive: _d,
					...tool
				}) => tool,
			),
		}));
		server.setRequestHandler(CallToolRequestSchema, async (req) => {
			const tool = allTools().find((t) => t.name === req.params.name);
			if (!tool) return text(`unknown tool ${req.params.name}`, true);
			const args = (req.params.arguments ?? {}) as Record<string, unknown>;
			if (tool.destructive && args.confirm !== true)
				return text(
					`${tool.name} is destructive and was not run. Ask the user, then call it again with "confirm": true.`,
					true,
				);
			let path = tool.path;
			for (const p of tool.pathParams) {
				const v = args[p];
				if (typeof v !== "string" || v === "")
					return text(`missing path parameter ${p}`, true);
				path = path.replace(`{${p}}`, encodeURIComponent(v));
			}
			const query = new URLSearchParams();
			for (const q of tool.queryParams) {
				const v = args[q];
				if (v !== undefined && v !== null) query.set(q, String(v));
			}
			const url = `/api${path}${query.size ? `?${query}` : ""}`;
			const headers: Record<string, string> = {
				authorization: `Bearer ${bearer}`,
				"user-agent": `logistack-mcp (${c.req.header("user-agent") ?? "unknown client"})`,
			};
			const ip = clientIp(c);
			if (ip) headers["x-forwarded-for"] = ip;
			const hasBody = tool.hasBody && args.body !== undefined;
			if (hasBody) headers["content-type"] = "application/json";
			const res = await app.request(
				url,
				{
					method: tool.method.toUpperCase(),
					headers,
					body: hasBody ? JSON.stringify(args.body) : undefined,
				},
				c.env,
			);
			const out = await res.text();
			return text(
				res.status === 204 ? `${res.status} done` : out,
				res.status >= 400,
			);
		});

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		await server.connect(transport);
		return transport.handleRequest(c.req.raw);
	};
}
