/**
 * Writes the config schemas `GET /api/integrations/schemas` serves into the mock adapter,
 * so VITE_API_MOCK=1 renders the same credential forms. Rerun after a provider schema changes:
 *
 *   bun scripts/dump-schemas.ts
 */
import { join } from "node:path";
import { z } from "zod";
import {
	dnsProviders,
	notificationChannels,
} from "../../../packages/providers/src/index.ts";

const dump = (defs: Record<string, { configSchema: z.ZodType }>) =>
	Object.fromEntries(
		Object.entries(defs).map(([k, d]) => [
			k,
			z.toJSONSchema(d.configSchema, { io: "input" }),
		]),
	);

const out = join(
	import.meta.dir,
	"..",
	"src",
	"lib",
	"api",
	"mock",
	"schemas.json",
);
await Bun.write(
	out,
	`${JSON.stringify({ dns: dump(dnsProviders), notify: dump(notificationChannels) }, null, "\t")}\n`,
);
console.log(`wrote ${out}`);
