import type {
	DatabaseEngine,
	DatabaseSchema,
	RowPatch,
	RowsPage,
	RowsQuery,
	RowsWritten,
	TableRef,
} from "@logistack/contracts";
import { ProviderError } from "../http.ts";
import { postgresClient } from "./postgres.ts";

export { rowsQuery } from "./postgres.ts";

export type DatabaseConnection = {
	engine: DatabaseEngine;
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
};

/**
 * Why an operation failed: the engine is down or off the network, refused our credentials,
 * rejected the statement, cannot do it, has no such table, or a row write missed its key.
 */
export type DatabaseFailure =
	| "unreachable"
	| "auth"
	| "query"
	| "unsupported"
	| "missing"
	| "stale";

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
	rows(ref: TableRef, q: RowsQuery): Promise<RowsPage>;
	/** Applies every patch in one transaction; any failure rolls all of them back. */
	mutate(ref: TableRef, ops: RowPatch[]): Promise<RowsWritten>;
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
