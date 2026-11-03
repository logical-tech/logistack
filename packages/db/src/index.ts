import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export { runMigrations } from "./migrate.ts";
export * from "./schema/index.ts";
export { schema };

/** Close with `await db.$client.end()`. */
export function createDb(
	url: string,
	options: postgres.Options<Record<string, never>> = {},
) {
	return drizzle(postgres(url, options), { schema });
}

export type Db = ReturnType<typeof createDb>;
