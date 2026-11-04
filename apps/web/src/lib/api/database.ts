/*
 * The database explorer: one database service's schema, pages of a table's rows and batched
 * row writes. Shapes come from @logistack/contracts; `mock/database.ts` fills the same slice
 * for VITE_API_MOCK=1.
 */
import type {
	CollectionRef,
	DatabaseSchema,
	DocumentsPage,
	DocumentWrite,
	DocumentWritten,
	QueryRequest,
	QueryResult,
	RedisBytes,
	RedisCommand,
	RedisKeysPage,
	RedisReply,
	RedisValue,
	RedisWrite,
	RedisWritten,
	RowFilter,
	RowPatch,
	RowSort,
	RowsPage,
	RowsWritten,
	TableRef,
} from "@logistack/contracts";
import {
	infiniteQueryOptions,
	keepPreviousData,
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { isMock } from ".";
import { ApiError } from "./adapter";
import { client } from "./client";
import { done, ok } from "./http";

/** A table, optionally in another database of the instance than the service's default one. */
export type DbTableRef = TableRef & { database?: string };

export type RowsQuery = {
	sort: RowSort[];
	filter: RowFilter[];
	cursor?: string;
};

/** Extended JSON texts given to Mongo's `find`; empty means none. */
export type DocumentsFind = {
	filter?: string;
	sort?: string;
	projection?: string;
};

export type DatabaseApi = {
	/** 409 with `details.reason` `unreachable` until a redeploy puts the service on ls-db. */
	schema(id: string, database?: string): Promise<DatabaseSchema>;
	rows(id: string, ref: DbTableRef, query: RowsQuery): Promise<RowsPage>;
	/** One transaction; 409 `stale` when an update or delete misses its row, 403 without write. */
	write(id: string, ref: DbTableRef, ops: RowPatch[]): Promise<RowsWritten>;
	/** Postgres database or MySQL schema; 400 when it exists, 403 without write. */
	createDatabase(id: string, name: string): Promise<void>;
	/** 403 without admin, 400 for the default database. */
	dropDatabase(id: string, name: string): Promise<void>;
	/** MongoDB: canonical Extended JSON documents; 400 for bad JSON or `$where`/`$function`. */
	documents(
		id: string,
		ref: CollectionRef,
		find: DocumentsFind & { cursor?: string },
	): Promise<DocumentsPage>;
	/** One insert, replace or delete; 409 `stale` when the `_id` is gone, 403 without write. */
	writeDocument(
		id: string,
		ref: CollectionRef,
		op: DocumentWrite,
	): Promise<DocumentWritten>;
	/** Redis: one SCAN batch of keys matching `match`; pass `cursor` back for more. */
	keys(
		id: string,
		q: { db: number; match: string; cursor?: string },
	): Promise<RedisKeysPage>;
	/** One page of a key's value; 404 once the key is gone. */
	keyValue(
		id: string,
		q: { db: number; key: RedisBytes; cursor?: string },
	): Promise<RedisValue>;
	/** One op; 409 `stale` when the key vanished or changed type, 403 without write. */
	writeKey(id: string, op: RedisWrite): Promise<RedisWritten>;
	/** One allowlisted command; 400 for a denied one, an error reply is a 200. */
	command(id: string, input: RedisCommand): Promise<RedisReply>;
	/** A failing statement is `error` in a 200; a write without `write` is a 403. */
	query(
		id: string,
		input: QueryRequest & { database?: string },
	): Promise<QueryResult>;
	/** 404 once the run has finished. */
	cancel(id: string, runId: string): Promise<void>;
	/**
	 * Starts the browser download of a full dump once a HEAD has checked it can: 403 without
	 * read:secrets, 409 without a running replica.
	 */
	dump(id: string): Promise<void>;
	/** Streams the file into the engine's restore tool; 403 without admin, 409 `tool_failed` with stderr. */
	restore(
		id: string,
		file: File,
		onProgress: (loaded: number) => void,
	): RestoreHandle;
};

export type RestoreHandle = {
	done: Promise<{ bytes: number }>;
	abort: () => void;
};

const dumpPath = (id: string) =>
	`/api/databases/${encodeURIComponent(id)}/dump`;

/** A HEAD has no body, so its refusal is named here. */
const headFailure: Record<number, [string, string]> = {
	403: [
		"You need read:secrets on this service to download a dump.",
		"forbidden",
	],
	404: ["This service no longer exists.", "not_found"],
	409: ["The database has no running replica to dump.", "conflict"],
};

function restoreUpload(
	id: string,
	file: File,
	onProgress: (loaded: number) => void,
): RestoreHandle {
	const xhr = new XMLHttpRequest();
	const done = new Promise<{ bytes: number }>((resolve, reject) => {
		xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onload = () => {
			const body = (() => {
				try {
					return JSON.parse(xhr.responseText);
				} catch {
					return undefined;
				}
			})();
			if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
			reject(
				new ApiError(
					xhr.status,
					body?.error?.message ?? `Restore failed with ${xhr.status}`,
					body?.error?.code,
					body?.error?.details,
				),
			);
		};
		xhr.onerror = () => reject(new Error("The connection dropped."));
		xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
	});
	xhr.open("POST", `/api/databases/${encodeURIComponent(id)}/restore`);
	xhr.withCredentials = true;
	xhr.setRequestHeader("Content-Type", "application/octet-stream");
	xhr.send(file);
	return { done, abort: () => xhr.abort() };
}

const PAGE = "200";
const d = client.api.databases[":id"];
const r = d.tables[":schema"][":table"].rows;
const docs = d.collections[":database"][":collection"].documents;

const on = (database?: string) => (database ? { database } : {});

const http: DatabaseApi = {
	schema: (id, database) =>
		ok(
			d.schema.$get({ param: { id }, query: on(database) }),
		) as Promise<DatabaseSchema>,
	rows: (id, { database, ...ref }, { sort, filter, cursor }) =>
		ok(
			r.$get({
				param: { id, ...ref },
				query: {
					...on(database),
					limit: PAGE,
					...(cursor ? { cursor } : {}),
					...(sort.length ? { sort: JSON.stringify(sort) } : {}),
					...(filter.length ? { filter: JSON.stringify(filter) } : {}),
				},
			}),
		) as Promise<RowsPage>,
	write: (id, { database, ...ref }, ops) =>
		ok(
			r.$post({ param: { id, ...ref }, query: on(database), json: { ops } }),
		) as Promise<RowsWritten>,
	createDatabase: (id, name) =>
		ok(d.databases.$post({ param: { id }, json: { name } })).then(() => {}),
	dropDatabase: (id, name) =>
		done(d.databases[":name"].$delete({ param: { id, name } })),
	documents: (id, ref, { cursor, ...find }) =>
		ok(
			docs.$get({
				param: { id, ...ref },
				query: {
					limit: PAGE,
					...(cursor ? { cursor } : {}),
					...Object.fromEntries(
						Object.entries(find).filter(([, v]) => v?.trim()),
					),
				},
			}),
		) as Promise<DocumentsPage>,
	writeDocument: (id, ref, json) =>
		ok(docs.$post({ param: { id, ...ref }, json })) as Promise<DocumentWritten>,
	keys: (id, { db, match, cursor }) =>
		ok(
			d.keys.$get({
				param: { id },
				query: {
					db: String(db),
					match,
					count: PAGE,
					...(cursor ? { cursor } : {}),
				},
			}),
		) as Promise<RedisKeysPage>,
	keyValue: (id, { db, key, cursor }) =>
		ok(
			d.keys.value.$get({
				param: { id },
				query: {
					db: String(db),
					count: PAGE,
					...(typeof key === "string"
						? { key }
						: { key: key.value, encoding: "base64" }),
					...(cursor ? { cursor } : {}),
				},
			}),
		) as Promise<RedisValue>,
	writeKey: (id, json) =>
		ok(d.keys.$post({ param: { id }, json })) as Promise<RedisWritten>,
	command: (id, json) =>
		ok(d.command.$post({ param: { id }, json })) as Promise<RedisReply>,
	query: (id, { database, ...json }) =>
		ok(
			d.query.$post({ param: { id }, query: on(database), json }),
		) as Promise<QueryResult>,
	cancel: (id, runId) =>
		done(d.query[":runId"].$delete({ param: { id, runId } })),
	dump: async (id) => {
		const res = await fetch(dumpPath(id), {
			method: "HEAD",
			credentials: "include",
		});
		if (!res.ok) {
			const [message, code] = headFailure[res.status] ?? [
				`The dump couldn't start (${res.status}).`,
				"internal",
			];
			throw new ApiError(res.status, message, code);
		}
		// Navigating streams the dump straight to disk; the browser marks a broken stream failed.
		const a = document.createElement("a");
		a.href = dumpPath(id);
		a.download = "";
		a.click();
	},
	restore: restoreUpload,
};

export const databaseApi: DatabaseApi = isMock
	? (await import("./mock/database")).mockDatabase
	: http;

/** The api's `details.reason` on a database error: unreachable, stale, auth, query, tool_failed, not_running. */
export const reasonOf = (e: unknown) =>
	e instanceof ApiError
		? (e.details as { reason?: string } | undefined)?.reason
		: undefined;

// Queries

const key = (id: string) => ["database", id];

export const schemaQuery = (id: string, database?: string) =>
	queryOptions({
		queryKey: [...key(id), "schema", database ?? null],
		queryFn: () => databaseApi.schema(id, database),
		// A 4xx is an answer (unreachable, wrong engine), not a hiccup to retry.
		retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
	});

export const rowsQuery = (
	id: string,
	ref: DbTableRef,
	query: Omit<RowsQuery, "cursor">,
) =>
	infiniteQueryOptions({
		queryKey: [
			...key(id),
			"rows",
			ref.database ?? null,
			ref.schema,
			ref.table,
			query,
		],
		queryFn: ({ pageParam }) =>
			databaseApi.rows(id, ref, {
				...query,
				...(pageParam ? { cursor: pageParam } : {}),
			}),
		initialPageParam: "",
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		// A new sort or filter swaps the rows in place instead of blanking the grid.
		placeholderData: keepPreviousData,
		retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
	});

export const documentsQuery = (
	id: string,
	ref: CollectionRef,
	find: DocumentsFind,
) =>
	infiniteQueryOptions({
		queryKey: [...key(id), "documents", ref.database, ref.collection, find],
		queryFn: ({ pageParam }) =>
			databaseApi.documents(id, ref, {
				...find,
				...(pageParam ? { cursor: pageParam } : {}),
			}),
		initialPageParam: "",
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		placeholderData: keepPreviousData,
		retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
	});

export const keysQuery = (id: string, db: number, match: string) =>
	infiniteQueryOptions({
		queryKey: [...key(id), "keys", db, match],
		queryFn: ({ pageParam }) =>
			databaseApi.keys(id, {
				db,
				match,
				...(pageParam ? { cursor: pageParam } : {}),
			}),
		initialPageParam: "",
		getNextPageParam: (last) => last.cursor ?? undefined,
		placeholderData: keepPreviousData,
		retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
	});

export const keyValueQuery = (id: string, db: number, k: RedisBytes) =>
	infiniteQueryOptions({
		queryKey: [...key(id), "key", db, k],
		queryFn: ({ pageParam }) =>
			databaseApi.keyValue(id, {
				db,
				key: k,
				...(pageParam ? { cursor: pageParam } : {}),
			}),
		initialPageParam: "",
		getNextPageParam: (last) =>
			"cursor" in last ? (last.cursor ?? undefined) : undefined,
		retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
	});

/** Changes one key, then refreshes the key list, the open value and the key counts. */
export function useWriteKey(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (op: RedisWrite) => databaseApi.writeKey(id, op),
		onSuccess: () => qc.invalidateQueries({ queryKey: key(id) }),
	});
}

export function useRedisCommand(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: RedisCommand) => databaseApi.command(id, input),
		// A command may have written anything; what is on screen reloads.
		onSuccess: () => qc.invalidateQueries({ queryKey: key(id) }),
	});
}

/** Writes one document, then refreshes the pages and the collection counts. */
export function useWriteDocument(id: string, ref: CollectionRef) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (op: DocumentWrite) => databaseApi.writeDocument(id, ref, op),
		onSuccess: () => qc.invalidateQueries({ queryKey: key(id) }),
	});
}

/** Writes one batch, then refreshes every page and the schema's row estimates. */
export function useWriteRows(id: string, ref: DbTableRef) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (ops: RowPatch[]) => databaseApi.write(id, ref, ops),
		onSuccess: () => qc.invalidateQueries({ queryKey: key(id) }),
	});
}

/** Creates or drops a database, then refreshes the schema and its database list. */
export function useDatabaseDdl(id: string) {
	const qc = useQueryClient();
	const refresh = () => qc.invalidateQueries({ queryKey: key(id) });
	return {
		create: useMutation({
			mutationFn: (name: string) => databaseApi.createDatabase(id, name),
			onSuccess: refresh,
		}),
		drop: useMutation({
			mutationFn: (name: string) => databaseApi.dropDatabase(id, name),
			onSuccess: refresh,
		}),
	};
}

/** Restores a file, then refreshes everything read from the database. */
export function useRestore(id: string) {
	const qc = useQueryClient();
	return (file: File, onProgress: (loaded: number) => void) => {
		const handle = databaseApi.restore(id, file, onProgress);
		handle.done.then(
			() => qc.invalidateQueries({ queryKey: key(id) }),
			() => {},
		);
		return handle;
	};
}
