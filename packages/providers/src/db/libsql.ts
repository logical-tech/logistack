import {
	type Cell,
	type DatabaseSchema,
	type DbColumn,
	type DbTable,
	QUERY_ROWS_LIMIT,
	type QueryResult,
	type RowFilter,
	type RowPatch,
	type RowsPage,
	type RowsQuery,
	type StatementResult,
	type TableRef,
} from "@logistack/contracts";
import { leadingWord, splitSql } from "@logistack/core";
import {
	type DatabaseConnection,
	DatabaseError,
	type SqlClient,
} from "./index.ts";

/*
 * libSQL (sqld) over Hrana 2 on HTTP: POST /v2/pipeline. A baton keeps one stream, and so one
 * transaction, open across requests; closing the stream rolls back anything left open.
 */

type HranaValue =
	| { type: "null" }
	| { type: "integer"; value: string }
	| { type: "float"; value: number }
	| { type: "text"; value: string }
	| { type: "blob"; base64: string };

type ExecResult = {
	cols: { name: string | null; decltype: string | null }[];
	rows: HranaValue[][];
	affected_row_count: number;
};

type StreamResult =
	| { type: "ok"; response: { type: string; result?: ExecResult } }
	| { type: "error"; error: { message: string; code?: string } };

/** SQLite's double-quoted identifier. */
export const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Hrana value to the api's cell: integers past 2^53 and blobs are tagged, as Postgres does. */
export function toCell(v: HranaValue): Cell {
	switch (v.type) {
		case "null":
			return null;
		case "integer": {
			const n = BigInt(v.value);
			return n > MAX_SAFE || n < -MAX_SAFE
				? { type: "bigint", value: v.value }
				: Number(n);
		}
		case "float":
			return v.value;
		case "text":
			return v.value;
		case "blob":
			return {
				type: "bytea",
				value: `\\x${Buffer.from(v.base64, "base64").toString("hex")}`,
			};
	}
}

/** The api's cell to a Hrana argument; plain strings go as text and SQLite applies the column's affinity. */
export function toArg(c: Cell): HranaValue {
	if (c === null) return { type: "null" };
	if (typeof c === "boolean") return { type: "integer", value: c ? "1" : "0" };
	if (typeof c === "number")
		return Number.isInteger(c)
			? { type: "integer", value: String(c) }
			: { type: "float", value: c };
	if (typeof c === "string") return { type: "text", value: c };
	if (c.type === "bigint") return { type: "integer", value: c.value };
	if (c.type === "bytea")
		return {
			type: "blob",
			base64: Buffer.from(c.value.replace(/^\\x/, ""), "hex").toString(
				"base64",
			),
		};
	return { type: "text", value: c.value };
}

/** WHERE clause and its arguments for the explorer's filters. */
export function whereOf(filters: RowFilter[], columns: Set<string>) {
	const parts: string[] = [];
	const args: HranaValue[] = [];
	for (const f of filters) {
		if (!columns.has(f.column))
			throw new DatabaseError("rows", `no column ${f.column}`, "query");
		const c = ident(f.column);
		const text = { type: "text" as const, value: f.value ?? "" };
		switch (f.op) {
			case "is_null":
				parts.push(`${c} IS NULL`);
				continue;
			case "not_null":
				parts.push(`${c} IS NOT NULL`);
				continue;
			case "contains":
				parts.push(`instr(CAST(${c} AS TEXT), ?) > 0`);
				break;
			case "starts_with":
				parts.push(`substr(CAST(${c} AS TEXT), 1, length(?)) = ?`);
				args.push(text);
				break;
			default: {
				const op = {
					eq: "=",
					neq: "<>",
					lt: "<",
					gt: ">",
					lte: "<=",
					gte: ">=",
				}[f.op];
				parts.push(`${c} ${op} ?`);
			}
		}
		args.push(text);
	}
	return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", args };
}

const decodeOffset = (cursor: string | undefined) => {
	if (!cursor) return 0;
	const n = Number(Buffer.from(cursor, "base64url").toString());
	if (!Number.isInteger(n) || n < 0)
		throw new DatabaseError("rows", "invalid cursor", "query");
	return n;
};
const encodeOffset = (n: number) =>
	Buffer.from(String(n)).toString("base64url");

export function libsqlClient(conn: DatabaseConnection): SqlClient {
	const base = `http://${conn.host}:${conn.port}`;
	const timeoutMs = conn.statementTimeoutMs ?? 30_000;

	/** One pipeline round trip; a non-2xx is the stream itself failing, not a statement. */
	async function pipeline(
		op: string,
		baton: string | null,
		requests: unknown[],
		signal?: AbortSignal,
	): Promise<{ baton: string | null; results: StreamResult[] }> {
		let res: Response;
		try {
			res = await fetch(`${base}/v2/pipeline`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${conn.password}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ baton, requests }),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
					: AbortSignal.timeout(timeoutMs),
			});
		} catch (e) {
			if (signal?.aborted) throw e;
			throw new DatabaseError(
				op,
				e instanceof Error ? e.message : String(e),
				"unreachable",
			);
		}
		if (res.status === 401 || res.status === 403)
			throw new DatabaseError(op, "sqld refused the auth token", "auth");
		if (!res.ok)
			throw new DatabaseError(
				op,
				`sqld answered ${res.status}: ${(await res.text()).slice(0, 200)}`,
				"unreachable",
			);
		return (await res.json()) as {
			baton: string | null;
			results: StreamResult[];
		};
	}

	const execute = (sql: string, args: HranaValue[] = []) => ({
		type: "execute",
		stmt: { sql, args, want_rows: true },
	});

	function unwrap(op: string, r: StreamResult | undefined): ExecResult {
		if (!r) throw new DatabaseError(op, "sqld sent no result", "query");
		if (r.type === "error")
			throw new DatabaseError(op, r.error.message, "query", r.error.code);
		if (!r.response.result)
			throw new DatabaseError(op, "sqld sent no rows", "query");
		return r.response.result;
	}

	/** Statements in one stream, closed after; any error throws. */
	async function run(
		op: string,
		stmts: { sql: string; args?: HranaValue[] }[],
	) {
		const { results } = await pipeline(op, null, [
			...stmts.map((s) => execute(s.sql, s.args)),
			{ type: "close" },
		]);
		return stmts.map((_, i) => unwrap(op, results[i]));
	}

	/** An interactive transaction: one stream kept open by its baton until `end`. */
	async function transaction<T>(
		op: string,
		body: (
			exec: (sql: string, args?: HranaValue[]) => Promise<StreamResult>,
		) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		let baton: string | null = null;
		const exec = async (sql: string, args: HranaValue[] = []) => {
			const r = await pipeline(op, baton, [execute(sql, args)], signal);
			baton = r.baton;
			return r.results[0] as StreamResult;
		};
		unwrap(op, await exec("BEGIN"));
		try {
			return await body(exec);
		} finally {
			// Closing rolls back whatever `body` did not commit.
			if (baton)
				await pipeline(op, baton, [{ type: "close" }]).catch(() => undefined);
		}
	}

	async function tables(): Promise<DbTable[]> {
		const [list] = await run("introspect", [
			{
				sql: "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'libsql\\_%' ESCAPE '\\' AND name NOT LIKE '\\_litestream%' ESCAPE '\\' ORDER BY name",
			},
		]);
		const names = (list?.rows ?? []).map((r) => ({
			name: String(toCell(r[0] as HranaValue)),
			view: toCell(r[1] as HranaValue) === "view",
		}));
		if (!names.length) return [];
		const info = await run(
			"introspect",
			names.flatMap((t) => [
				{ sql: `PRAGMA table_info(${ident(t.name)})` },
				{ sql: `PRAGMA foreign_key_list(${ident(t.name)})` },
			]),
		);
		return names.map((t, i) => {
			const cols = info[i * 2]?.rows ?? [];
			const fks = info[i * 2 + 1]?.rows ?? [];
			const columns: DbColumn[] = cols.map((r) => {
				const [, name, type, notnull, dflt, pk] = r.map((v) => toCell(v));
				return {
					name: String(name),
					type: String(type ?? "").toLowerCase(),
					nullable: notnull !== 1,
					default: dflt === null || dflt === undefined ? null : String(dflt),
					primaryKey: typeof pk === "number" && pk > 0,
				};
			});
			const byId = new Map<number, DbTable["foreignKeys"] & object>();
			for (const r of fks) {
				const [id, , table, from, to] = r.map((v) => toCell(v));
				const key = Number(id);
				const list = byId.get(key) ?? [];
				if (!list.length)
					list.push({
						name: `fk_${t.name}_${key}`,
						columns: [],
						refSchema: "main",
						refTable: String(table),
						refColumns: [],
					});
				const fk = list[0] as NonNullable<DbTable["foreignKeys"]>[number];
				fk.columns.push(String(from));
				// A missing `to` means the parent's primary key; the diagram only needs the table.
				fk.refColumns.push(to === null ? String(from) : String(to));
				byId.set(key, list);
			}
			return {
				name: t.name,
				kind: t.view ? ("view" as const) : ("table" as const),
				rows: null,
				editable: !t.view && columns.some((c) => c.primaryKey),
				columns,
				foreignKeys: [...byId.values()].flat(),
			};
		});
	}

	async function table(op: string, ref: TableRef) {
		const t = (await tables()).find((x) => x.name === ref.table);
		if (!t || ref.schema !== "main")
			throw new DatabaseError(op, `no table ${ref.table}`, "missing");
		return t;
	}

	return {
		kind: "sql",
		async introspect(): Promise<DatabaseSchema> {
			return {
				engine: "libsql",
				database: "main",
				schemas: [{ name: "main", tables: await tables() }],
			};
		},
		async rows(ref: TableRef, q: RowsQuery): Promise<RowsPage> {
			const t = await table("rows", ref);
			const names = new Set(t.columns.map((c) => c.name));
			for (const s of q.sort)
				if (!names.has(s.column))
					throw new DatabaseError("rows", `no column ${s.column}`, "query");
			const where = whereOf(q.filter, names);
			const pk = t.columns.filter((c) => c.primaryKey).map((c) => c.name);
			const order = [
				...q.sort.map((s) => `${ident(s.column)} ${s.desc ? "DESC" : "ASC"}`),
				...(pk.length ? pk : ["rowid"])
					.filter((k) => !q.sort.some((s) => s.column === k))
					.map((k) => (k === "rowid" ? "rowid" : ident(k))),
			];
			const offset = decodeOffset(q.cursor);
			const select = t.columns.map((c) => ident(c.name)).join(", ");
			const [res] = await run("rows", [
				{
					sql: `SELECT ${select} FROM ${ident(t.name)}${where.sql}${t.kind === "view" && !pk.length ? "" : ` ORDER BY ${order.join(", ")}`} LIMIT ? OFFSET ?`,
					args: [
						...where.args,
						{ type: "integer", value: String(q.limit + 1) },
						{ type: "integer", value: String(offset) },
					],
				},
			]);
			const rows = (res?.rows ?? []).map((r) => r.map(toCell));
			return {
				columns: t.columns,
				editable: t.editable,
				rows: rows.slice(0, q.limit),
				nextCursor:
					rows.length > q.limit ? encodeOffset(offset + q.limit) : null,
			};
		},
		async mutate(ref: TableRef, ops: RowPatch[]) {
			const t = await table("mutate", ref);
			if (!t.editable)
				throw new DatabaseError(
					"mutate",
					`${t.name} has no primary key`,
					"unsupported",
				);
			const names = new Set(t.columns.map((c) => c.name));
			const check = (values: Record<string, Cell>) => {
				for (const k of Object.keys(values))
					if (!names.has(k))
						throw new DatabaseError("mutate", `no column ${k}`, "query");
			};
			const returning = ` RETURNING ${t.columns.map((c) => ident(c.name)).join(", ")}`;
			const keyOf = (key: Record<string, Cell>) => {
				check(key);
				const ks = Object.keys(key);
				return {
					sql: ks.map((k) => `${ident(k)} = ?`).join(" AND "),
					args: ks.map((k) => toArg(key[k] ?? null)),
				};
			};
			return transaction("mutate", async (exec) => {
				const out: (Cell[] | null)[] = [];
				for (const op of ops) {
					let sql: string;
					let args: HranaValue[];
					if (op.op === "insert") {
						check(op.values);
						const ks = Object.keys(op.values);
						sql = ks.length
							? `INSERT INTO ${ident(t.name)} (${ks.map(ident).join(", ")}) VALUES (${ks.map(() => "?").join(", ")})${returning}`
							: `INSERT INTO ${ident(t.name)} DEFAULT VALUES${returning}`;
						args = ks.map((k) => toArg(op.values[k] ?? null));
					} else if (op.op === "update") {
						check(op.values);
						const ks = Object.keys(op.values);
						const key = keyOf(op.key);
						sql = `UPDATE ${ident(t.name)} SET ${ks.map((k) => `${ident(k)} = ?`).join(", ")} WHERE ${key.sql}${returning}`;
						args = [...ks.map((k) => toArg(op.values[k] ?? null)), ...key.args];
					} else {
						const key = keyOf(op.key);
						sql = `DELETE FROM ${ident(t.name)} WHERE ${key.sql}${returning}`;
						args = key.args;
					}
					const res = unwrap("mutate", await exec(sql, args));
					if (op.op !== "insert" && res.rows.length !== 1)
						throw new DatabaseError(
							"mutate",
							`the ${op.op} matched ${res.rows.length} rows, not one`,
							"stale",
						);
					out.push(op.op === "delete" ? null : (res.rows[0] ?? []).map(toCell));
				}
				unwrap("mutate", await exec("COMMIT"));
				return { rows: out };
			});
		},
		async query(script, { readOnly, signal }): Promise<QueryResult> {
			const statements = splitSql(script, "postgres");
			const results: StatementResult[] = [];
			return transaction(
				"query",
				async (exec) => {
					for (const [i, s] of statements.entries()) {
						const started = performance.now();
						const r = await exec(s.text);
						if (r.type === "error")
							return {
								results,
								error: {
									statement: i,
									message: r.error.message,
									...(r.error.code ? { code: r.error.code } : {}),
								},
							};
						const res = unwrap("query", r);
						const truncated = res.rows.length > QUERY_ROWS_LIMIT;
						results.push({
							from: s.from,
							to: s.to,
							command: leadingWord(s.text).toUpperCase(),
							columns: res.cols.map((c, j) => ({
								name: c.name ?? `column${j + 1}`,
								type: (c.decltype ?? "").toLowerCase(),
							})),
							rows: res.rows
								.slice(0, QUERY_ROWS_LIMIT)
								.map((row) => row.map(toCell)),
							truncated,
							affected: res.cols.length
								? truncated
									? null
									: res.rows.length
								: res.affected_row_count,
							durationMs: Math.round(performance.now() - started),
						});
					}
					// A read-only run rolls back, so nothing it did can persist.
					unwrap("query", await exec(readOnly ? "ROLLBACK" : "COMMIT"));
					return { results, error: null };
				},
				signal,
			);
		},
		async createDatabase() {
			throw new DatabaseError(
				"createDatabase",
				"a libSQL server holds one database",
				"unsupported",
			);
		},
		async dropDatabase() {
			throw new DatabaseError(
				"dropDatabase",
				"a libSQL server holds one database",
				"unsupported",
			);
		},
		async createRole() {
			throw new DatabaseError(
				"createRole",
				"libSQL authenticates with signed tokens, not roles",
				"unsupported",
			);
		},
		async setPassword() {
			throw new DatabaseError(
				"setPassword",
				"libSQL authenticates with signed tokens, not passwords",
				"unsupported",
			);
		},
		async close() {},
	};
}
