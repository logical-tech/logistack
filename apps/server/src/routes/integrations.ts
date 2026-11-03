import { createRoute, z } from "@hono/zod-openapi";
import { dnsProviders, notificationChannels } from "@logistack/providers";
import { json, router } from "../openapi.ts";

const jsonSchemas = (defs: Record<string, { configSchema: z.ZodType }>) =>
	Object.fromEntries(
		Object.entries(defs).map(([kind, d]) => [
			kind,
			// Input side: defaults stay optional, and `secret: true` sits on the string before any pipe.
			z.toJSONSchema(d.configSchema, { io: "input" }) as Record<
				string,
				unknown
			>,
		]),
	);

// Static: computed once, served to the setup wizard before anyone can sign in.
const schemas = {
	dns: jsonSchemas(dnsProviders),
	notify: jsonSchemas(notificationChannels),
};

const SchemaMap = z.record(z.string(), z.record(z.string(), z.unknown()));

export const integrations = router().openapi(
	createRoute({
		method: "get",
		path: "/integrations/schemas",
		tags: ["integrations"],
		summary:
			"JSON Schema of each DNS provider's and notification channel's config",
		description:
			"Fields marked `secret: true` are credentials: forms mask them and the API never returns them.",
		responses: {
			200: json(
				z
					.object({ dns: SchemaMap, notify: SchemaMap })
					.openapi("IntegrationSchemas"),
				"Schemas",
			),
		},
	}),
	(c) => c.json(schemas, 200),
);
