import type { DatabaseEngine, DatabaseSchema } from "@logistack/contracts";
import { ProviderError } from "../http.ts";
import { postgresClient } from "./postgres.ts";

export type DatabaseConnection = {
	engine: DatabaseEngine;
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
};

/** Why an operation failed: the engine is down or off the network, refused our credentials, or rejected the statement. */
export type DatabaseFailure = "unreachable" | "auth" | "query" | "unsupported";

export class DatabaseError extends ProviderError {
	constructor(
		op: string,
		message: string,
		readonly reason: DatabaseFailure,
		readonly code?: string,
	) {
		super("database", op, message);
	}
}

/** What the explorer runs against one database service; one implementation per engine. */
export type DatabaseClient = {
	introspect(): Promise<DatabaseSchema>;
	close(): Promise<void>;
};

export function databaseClient(conn: DatabaseConnection): DatabaseClient {
	if (conn.engine === "postgres") return postgresClient(conn);
	throw new DatabaseError(
		"open",
		`the explorer does not support ${conn.engine} yet`,
		"unsupported",
	);
}
