import type {
	CollectionRef,
	DatabaseEngine,
	DatabaseSchema,
	DocumentsPage,
	DocumentsQuery,
	DocumentWrite,
	DocumentWritten,
	QueryResult,
	RowPatch,
	RowsPage,
	RowsQuery,
	RowsWritten,
	TableRef,
} from "@logistack/contracts";
import { ProviderError } from "../http.ts";
import { mongoClient } from "./mongo.ts";
import { mysqlClient } from "./mysql.ts";
import { postgresClient } from "./postgres.ts";

export { rowsQuery } from "./postgres.ts";

export type DatabaseConnection = {
	engine: DatabaseEngine;
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	/** Per statement, explorer queries included; default 30 s. */
	statementTimeoutMs?: number;
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

type Common = {
	introspect(): Promise<DatabaseSchema>;
	close(): Promise<void>;
};

/** What the explorer runs against one database service; one implementation per engine. */
export type DatabaseClient = SqlClient | DocumentClient;

export type SqlClient = Common & {
	kind: "sql";
	rows(ref: TableRef, q: RowsQuery): Promise<RowsPage>;
	/** Applies every patch in one transaction; any failure rolls all of them back. */
	mutate(ref: TableRef, ops: RowPatch[]): Promise<RowsWritten>;
	/**
	 * Runs a script's statements in order, in one transaction (READ ONLY when asked). A statement
	 * that fails, times out or is aborted through `signal` rolls the whole run back and comes
	 * back as `error`; only a lost connection throws.
	 */
	query(
		script: string,
		opts: { readOnly: boolean; signal?: AbortSignal },
	): Promise<QueryResult>;
};

/** MongoDB: documents in canonical Extended JSON, never rows. */
export type DocumentClient = Common & {
	kind: "document";
	find(ref: CollectionRef, q: DocumentsQuery): Promise<DocumentsPage>;
	/** A replace or delete whose `_id` matches nothing fails with `stale`. */
	write(ref: CollectionRef, op: DocumentWrite): Promise<DocumentWritten>;
};

export function databaseClient(conn: DatabaseConnection): DatabaseClient {
	if (conn.engine === "postgres") return postgresClient(conn);
	if (conn.engine === "mysql" || conn.engine === "mariadb")
		return mysqlClient(conn);
	if (conn.engine === "mongo") return mongoClient(conn);
	throw new DatabaseError(
		"open",
		`the explorer does not support ${conn.engine} yet`,
		"unsupported",
	);
}
