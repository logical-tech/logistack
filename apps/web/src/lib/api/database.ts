/*
 * The database explorer: one database service's schema, pages of a table's rows and batched
 * row writes. Shapes come from @logistack/contracts; `mock/database.ts` fills the same slice
 * for VITE_API_MOCK=1.
 */
import type {
	DatabaseSchema,
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
import { ok } from "./http";

export type RowsQuery = {
	sort: RowSort[];
	filter: RowFilter[];
	cursor?: string;
};

export type DatabaseApi = {
	/** 409 with `details.reason` `unreachable` until a redeploy puts the service on ls-db. */
	schema(id: string): Promise<DatabaseSchema>;
	rows(id: string, ref: TableRef, query: RowsQuery): Promise<RowsPage>;
	/** One transaction; 409 `stale` when an update or delete misses its row, 403 without write. */
	write(id: string, ref: TableRef, ops: RowPatch[]): Promise<RowsWritten>;
};

const PAGE = "200";
const d = client.api.databases[":id"];
const r = d.tables[":schema"][":table"].rows;

const http: DatabaseApi = {
	schema: (id) =>
		ok(d.schema.$get({ param: { id } })) as Promise<DatabaseSchema>,
	rows: (id, ref, { sort, filter, cursor }) =>
		ok(
			r.$get({
				param: { id, ...ref },
				query: {
					limit: PAGE,
					...(cursor ? { cursor } : {}),
					...(sort.length ? { sort: JSON.stringify(sort) } : {}),
					...(filter.length ? { filter: JSON.stringify(filter) } : {}),
				},
			}),
		) as Promise<RowsPage>,
	write: (id, ref, ops) =>
		ok(
			r.$post({ param: { id, ...ref }, json: { ops } }),
		) as Promise<RowsWritten>,
};

export const databaseApi: DatabaseApi = isMock
	? (await import("./mock/database")).mockDatabase
	: http;

/** The api's `details.reason` on a database error: unreachable, stale, auth, query. */
export const reasonOf = (e: unknown) =>
	e instanceof ApiError
		? (e.details as { reason?: string } | undefined)?.reason
		: undefined;

// Queries

const key = (id: string) => ["database", id];

export const schemaQuery = (id: string) =>
	queryOptions({
		queryKey: [...key(id), "schema"],
		queryFn: () => databaseApi.schema(id),
		// A 4xx is an answer (unreachable, wrong engine), not a hiccup to retry.
		retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
	});

export const rowsQuery = (
	id: string,
	ref: TableRef,
	query: Omit<RowsQuery, "cursor">,
) =>
	infiniteQueryOptions({
		queryKey: [...key(id), "rows", ref.schema, ref.table, query],
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

/** Writes one batch, then refreshes every page and the schema's row estimates. */
export function useWriteRows(id: string, ref: TableRef) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (ops: RowPatch[]) => databaseApi.write(id, ref, ops),
		onSuccess: () => qc.invalidateQueries({ queryKey: key(id) }),
	});
}
