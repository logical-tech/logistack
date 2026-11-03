import { randomBytes } from "node:crypto";
import type { DatabaseEngine } from "@logistack/contracts";
import { libsqlCredentials } from "./libsql.ts";

// base64url: safe inside connection URLs and shell double quotes without escaping.
const password = () => randomBytes(24).toString("base64url");

/** The env a new managed database is created with: what its image needs to initialise. */
export function databaseCredentials(
	engine: DatabaseEngine,
): Record<string, string> {
	switch (engine) {
		case "postgres":
			return { POSTGRES_PASSWORD: password() };
		case "mysql":
			return { MYSQL_ROOT_PASSWORD: password() };
		case "mariadb":
			return { MARIADB_ROOT_PASSWORD: password() };
		case "mongo":
			return {
				MONGO_INITDB_ROOT_USERNAME: "root",
				MONGO_INITDB_ROOT_PASSWORD: password(),
			};
		case "redis":
			return { REDIS_PASSWORD: password() };
		case "libsql":
			return libsqlCredentials();
	}
}
