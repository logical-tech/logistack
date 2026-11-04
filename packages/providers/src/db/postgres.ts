import {
	type Cell,
	type DatabaseSchema,
	type DbColumn,
	type DbRole,
	type DbTable,
	QUERY_ROWS_LIMIT,
	type QueryError,
	type QueryResult,
	type RowFilter,
	type RowPatch,
	type RowsPage,
	type RowsQuery,
	type RowsWritten,
	type StatementResult,
	type TableRef,
} from "@logistack/contracts";
import { leadingWord, splitSql } from "@logistack/core";
import postgres, { type PendingQuery, type Row, type Sql } from "postgres";
import {
	type DatabaseConnection,
	DatabaseError,
	type SqlClient,
} from "./index.ts";
import { scramVerifier } from "./scram.ts";

const UNREACHABLE = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ETIMEDOUT",
	"CONNECT_TIMEOUT",
	"CONNECTION_CLOSED",
	"CONNECTION_ENDED",
	"CONNECTION_DESTROYED",
]);
// invalid_password, invalid_authorization_specification
const AUTH = new Set(["28P01", "28000"]);
// invalid_catalog_name: the database asked for does not exist.
const MISSING = new Set(["3D000"]);

function wrap(op: string, e: unknown): DatabaseError {
	const err = e as { code?: string; errno?: string; message?: string };
	const code = err.code ?? err.errno;
	const reason =
		code && UNREACHABLE.has(code)
			? "unreachable"
			: code && AUTH.has(code)
				? "auth"
				: code && MISSING.has(code)
					? "missing"
					: "query";
	return new DatabaseError(op, err.message ?? String(e), reason, code);
}

const kinds: Record<string, DbTable["kind"]> = {
	r: "table",
	p: "table",
	v: "view",
	m: "materialized_view",
	f: "foreign_table",
};

type ColumnRow = {
	schema: string;
	table: string;
	kind: string;
	rows: number | null;
	column: string | null;
	type: string | null;
	nullable: boolean | null;
	default: string | null;
	pk: boolean | null;
};

const raw = (x: unknown) => String(x);

// Tagged so a JSON consumer never mistakes them for a JS number or a plain string.
const tagged: Record<number, "bigint" | "numeric" | "bytea" | "json"> = {
	17: "bytea",
	20: "bigint",
	114: "json",
	1700: "numeric",
	3802: "json",
};

function cell(v: unknown, oid: number): Cell {
	if (v === null || v === undefined) return null;
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
	const type = tagged[oid];
	return type ? { type, value: String(v) } : String(v);
}

const cellText = (c: Cell) =>
	c === null ? null : typeof c === "object" ? c.value : String(c);

const encodeRow = (row: unknown[], columns: readonly { type: number }[]) =>
	row.map((v, i) => cell(v, columns[i]?.type ?? 0));

type Table = { kind: DbTable["kind"]; columns: DbColumn[]; key: string[] };

const bad = (op: string, message: string) =>
	new DatabaseError(op, message, "query");

/**
 * A quoted identifier. postgres.js's own `sql(name)` splits on dots, so `a.b` would address
 * column b of a; doubling the quotes keeps any name one identifier.
 */
function ident(sql: Sql, name: string) {
	return sql`${sql.unsafe(`"${name.replaceAll('"', '""')}"`)}`;
}

const join = (sql: Sql, parts: PendingQuery<Row[]>[], sep: "and" | ",") =>
	parts.reduce((a, b) =>
		sep === "and" ? sql`${a} and ${b}` : sql`${a}, ${b}`,
	);

const relation = (sql: Sql, ref: TableRef) =>
	sql`${ident(sql, ref.schema)}.${ident(sql, ref.table)}`;

function filterSql(sql: Sql, f: RowFilter) {
	const col = ident(sql, f.column);
	if (f.op === "is_null") return sql`${col} is null`;
	if (f.op === "not_null") return sql`${col} is not null`;
	const v = f.value;
	if (v === undefined) throw bad("rows", `filter ${f.op} needs a value`);
	switch (f.op) {
		case "eq":
			return sql`${col} = ${v}`;
		case "neq":
			return sql`${col} <> ${v}`;
		case "lt":
			return sql`${col} < ${v}`;
		case "gt":
			return sql`${col} > ${v}`;
		case "lte":
			return sql`${col} <= ${v}`;
		case "gte":
			return sql`${col} >= ${v}`;
		case "contains":
			return sql`strpos(${col}::text, ${v}) > 0`;
		case "starts_with":
			return sql`starts_with(${col}::text, ${v})`;
	}
}

type Cursor = { k: string[] } | { o: number };

function decodeCursor(cursor: string): Cursor {
	try {
		const v = JSON.parse(Buffer.from(cursor, "base64url").toString());
		if (Array.isArray(v?.k) && v.k.every((x: unknown) => typeof x === "string"))
			return { k: v.k };
		if (Number.isInteger(v?.o) && v.o >= 0) return { o: v.o };
	} catch {}
	throw bad("rows", "invalid cursor");
}

const encodeCursor = (c: Cursor) =>
	Buffer.from(JSON.stringify(c)).toString("base64url");

/**
 * The page query for `q`. Sorting by exactly the primary key in one direction pages by keyset,
 * so a deep page costs an index seek; any other sort pages by offset, tie-broken by the key.
 */
export function rowsQuery(
	sql: Sql,
	ref: TableRef,
	table: { columns: string[]; key: string[] },
	q: RowsQuery,
) {
	const known = new Set(table.columns);
	for (const { column } of [...q.sort, ...q.filter])
		if (!known.has(column)) throw bad("rows", `unknown column ${column}`);
	const { key } = table;
	const sort = q.sort.length
		? [...q.sort]
		: key.map((column) => ({ column, desc: false }));
	const desc = sort[0]?.desc ?? false;
	const keyset =
		key.length > 0 &&
		sort.length === key.length &&
		sort.every((s, i) => s.column === key[i] && s.desc === desc);
	if (!keyset)
		for (const column of key)
			if (!sort.some((s) => s.column === column))
				sort.push({ column, desc: false });

	const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
	if (cursor && "k" in cursor !== keyset)
		throw bad("rows", "the cursor belongs to a different sort");
	const where = q.filter.map((f) => filterSql(sql, f));
	if (cursor && "k" in cursor) {
		if (cursor.k.length !== key.length) throw bad("rows", "invalid cursor");
		const cols = join(
			sql,
			key.map((c) => ident(sql, c)),
			",",
		);
		const vals = join(
			sql,
			cursor.k.map((v) => sql`${v}`),
			",",
		);
		where.push(desc ? sql`(${cols}) < (${vals})` : sql`(${cols}) > (${vals})`);
	}
	const offset = cursor && "o" in cursor ? cursor.o : 0;
	const order = sort.length
		? sql`order by ${join(
				sql,
				sort.map((s) =>
					s.desc
						? sql`${ident(sql, s.column)} desc`
						: sql`${ident(sql, s.column)} asc`,
				),
				",",
			)}`
		: sql``;
	return {
		keyset,
		offset,
		query: sql`select * from ${relation(sql, ref)}
			${where.length ? sql`where ${join(sql, where, "and")}` : sql``}
			${order} limit ${q.limit + 1} offset ${offset}`,
	};
}

// A run is one transaction the explorer owns, so statements that end or open one are refused.
const TX_CONTROL = new Set([
	"begin",
	"start",
	"commit",
	"end",
	"rollback",
	"abort",
]);

const ms = (since: number) => Math.round((performance.now() - since) * 10) / 10;

export function postgresClient(conn: DatabaseConnection): SqlClient {
	const timeout = conn.statementTimeoutMs ?? 30_000;
	// oid -> type name, for result headers; types rarely change, so it lives as long as the pool.
	const typeNames = new Map<number, string>();
	const sql = postgres({
		host: conn.host,
		port: conn.port,
		user: conn.user,
		password: conn.password,
		database: conn.database,
		max: 4,
		// Idle connections close on their own; the next call reconnects.
		idle_timeout: 300,
		connect_timeout: 5,
		onnotice: () => {},
		connection: {
			application_name: "logistack-explorer",
			statement_timeout: timeout,
			idle_in_transaction_session_timeout: timeout * 2,
		},
		// Array values stay in their text form too.
		fetch_types: false,
		// Values cross in the engine's text form both ways, never through a JS Date, Buffer or
		// JSON.parse, so nothing is rounded. Binds are always strings for the engine to parse.
		types: {
			text: {
				to: 25,
				from: [17, 114, 1082, 1114, 1184, 3802],
				serialize: raw,
				parse: raw,
			},
			bool: {
				to: 16,
				from: [16],
				serialize: raw,
				parse: (x: string) => x === "t",
			},
		},
	});

	async function describe(ref: TableRef, op: string): Promise<Table> {
		const rows = await sql<
			(Omit<DbColumn, "primaryKey"> & { kind: string; key: number | null })[]
		>`
			select c.relkind as kind, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
				not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as default,
				array_position(i.indkey::int2[], a.attnum) as key
			from pg_class c
			join pg_namespace n on n.oid = c.relnamespace
			join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
			left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
			left join pg_index i on i.indrelid = c.oid and i.indisprimary
			where n.nspname = ${ref.schema} and c.relname = ${ref.table}
				and c.relkind in ('r', 'p', 'v', 'm', 'f')
			order by a.attnum`;
		const first = rows[0];
		if (!first)
			throw new DatabaseError(
				op,
				`${ref.schema}.${ref.table} does not exist`,
				"missing",
			);
		const kind = kinds[first.kind] ?? "table";
		return {
			kind,
			columns: rows.map(({ kind: _, key, ...c }) => ({
				...c,
				primaryKey: key !== null,
			})),
			key: rows
				.filter((r) => r.key !== null && kind === "table")
				.sort((a, b) => (a.key ?? 0) - (b.key ?? 0))
				.map((r) => r.name),
		};
	}

	const pick = (table: Table, values: Record<string, Cell>) => {
		const out: Record<string, string | null> = {};
		for (const [name, v] of Object.entries(values)) {
			if (!table.columns.some((c) => c.name === name))
				throw bad("mutate", `unknown column ${name}`);
			out[name] = cellText(v);
		}
		return out;
	};

	const insertValues = (values: Record<string, string | null>) => {
		const names = Object.keys(values);
		return sql`(${join(
			sql,
			names.map((n) => ident(sql, n)),
			",",
		)}) values (${join(
			sql,
			names.map((n) => sql`${values[n] ?? null}`),
			",",
		)})`;
	};

	const assignments = (values: Record<string, string | null>) =>
		join(
			sql,
			Object.entries(values).map(([n, v]) => sql`${ident(sql, n)} = ${v}`),
			",",
		);

	/** Replaces each column's type oid with its name: int4, text, _int4 as int4[]. */
	async function nameTypes(results: StatementResult[]) {
		const columns = results.flatMap((r) => r.columns);
		const missing = [...new Set(columns.map((c) => Number(c.type)))].filter(
			(oid) => !typeNames.has(oid),
		);
		if (missing.length)
			try {
				const rows = await sql<{ oid: number; name: string }[]>`
					select t.oid::int4 as oid,
						case when e.oid is not null and t.typcategory = 'A' then e.typname || '[]' else t.typname end as name
					from pg_type t left join pg_type e on e.oid = t.typelem
					where t.oid = any(${`{${missing.join(",")}}`}::oid[])`;
				for (const r of rows) typeNames.set(r.oid, r.name);
			} catch {
				// Headers fall back to the oid; the results matter more.
			}
		for (const c of columns) c.type = typeNames.get(Number(c.type)) ?? c.type;
	}

	function keyMatch(table: Table, key: Record<string, Cell>) {
		const names = Object.keys(key);
		if (
			names.length !== table.key.length ||
			!table.key.every((k) => names.includes(k))
		)
			throw bad(
				"mutate",
				`key must be exactly the primary key (${table.key.join(", ")})`,
			);
		return join(
			sql,
			table.key.map((k) => sql`${ident(sql, k)} = ${cellText(key[k] ?? null)}`),
			"and",
		);
	}

	return {
		kind: "sql",
		async introspect(): Promise<DatabaseSchema> {
			try {
				const [
					schemas,
					columns,
					databases,
					enums,
					sequences,
					routines,
					foreignKeys,
					roles,
					grants,
				] = await Promise.all([
					sql<{ name: string }[]>`
						select nspname as name from pg_namespace
						where nspname not in ('pg_catalog', 'information_schema')
							and nspname not like 'pg\\_toast%' and nspname not like 'pg\\_temp%'
						order by nspname`,
					sql<ColumnRow[]>`
						select n.nspname as schema, c.relname as table, c.relkind as kind,
							case when c.reltuples < 0 then null else c.reltuples::float8 end as rows,
							a.attname as column, format_type(a.atttypid, a.atttypmod) as type,
							not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as default,
							a.attnum = any(i.indkey) as pk
						from pg_class c
						join pg_namespace n on n.oid = c.relnamespace
						left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
						left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
						left join pg_index i on i.indrelid = c.oid and i.indisprimary
						where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
							and n.nspname not in ('pg_catalog', 'information_schema')
							and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
						order by n.nspname, c.relname, a.attnum`,
					sql<{ name: string }[]>`
						select datname as name from pg_database
						where not datistemplate and datallowconn order by datname`,
					sql<{ schema: string; name: string; values: string }[]>`
						select n.nspname as schema, t.typname as name,
							json_agg(e.enumlabel order by e.enumsortorder) as "values"
						from pg_type t
						join pg_namespace n on n.oid = t.typnamespace
						join pg_enum e on e.enumtypid = t.oid
						where n.nspname not in ('pg_catalog', 'information_schema')
							and not exists (select from pg_depend d where d.classid = 'pg_type'::regclass
								and d.objid = t.oid and d.deptype = 'e')
						group by n.nspname, t.typname order by n.nspname, t.typname`,
					sql<{ schema: string; name: string }[]>`
						select n.nspname as schema, c.relname as name
						from pg_class c join pg_namespace n on n.oid = c.relnamespace
						where c.relkind = 'S' and n.nspname not in ('pg_catalog', 'information_schema')
							and not exists (select from pg_depend d where d.classid = 'pg_class'::regclass
								and d.objid = c.oid and d.deptype = 'e')
						order by n.nspname, c.relname`,
					sql<
						{
							schema: string;
							name: string;
							kind: string;
							arguments: string;
							returns: string | null;
						}[]
					>`
						select n.nspname as schema, p.proname as name, p.prokind as kind,
							pg_get_function_identity_arguments(p.oid) as arguments,
							case when p.prokind = 'f' then pg_get_function_result(p.oid) end as returns
						from pg_proc p join pg_namespace n on n.oid = p.pronamespace
						where p.prokind in ('f', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
							and not exists (select from pg_depend d where d.classid = 'pg_proc'::regclass
								and d.objid = p.oid and d.deptype = 'e')
						order by n.nspname, p.proname, 4`,
					sql<
						{
							schema: string;
							table: string;
							name: string;
							columns: string;
							refSchema: string;
							refTable: string;
							refColumns: string;
						}[]
					>`
						select n.nspname as schema, c.relname as table, con.conname as name,
							array_to_json(array(select a.attname from unnest(con.conkey) with ordinality k(num, i)
								join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.num
								order by k.i))::text as columns,
							rn.nspname as "refSchema", rc.relname as "refTable",
							array_to_json(array(select a.attname from unnest(con.confkey) with ordinality k(num, i)
								join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.num
								order by k.i))::text as "refColumns"
						from pg_constraint con
						join pg_class c on c.oid = con.conrelid
						join pg_namespace n on n.oid = c.relnamespace
						join pg_class rc on rc.oid = con.confrelid
						join pg_namespace rn on rn.oid = rc.relnamespace
						-- A partition's copy of its parent's key has a conparentid.
						where con.contype = 'f' and con.conparentid = 0
							and n.nspname not in ('pg_catalog', 'information_schema')
						order by n.nspname, c.relname, con.conname`,
					sql<(Omit<DbRole, "grants" | "memberOf"> & { memberOf: string })[]>`
						select r.rolname as name, r.rolcanlogin as login, r.rolsuper as superuser,
							r.rolcreatedb as "createDb", r.rolcreaterole as "createRole",
							array_to_json(array(select b.rolname from pg_auth_members m
								join pg_roles b on b.oid = m.roleid
								where m.member = r.oid order by 1))::text as "memberOf"
						from pg_roles r where r.rolname !~ '^pg_' order by r.rolname`,
					// From the ACLs themselves: information_schema only lists the current user's.
					sql<{ role: string; schema: string; privileges: string }[]>`
						select g.rolname as role, n.nspname as schema,
							json_agg(distinct a.privilege_type order by a.privilege_type)::text as privileges
						from pg_class c
						join pg_namespace n on n.oid = c.relnamespace
						cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
						join pg_roles g on g.oid = a.grantee
						where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
							and n.nspname not in ('pg_catalog', 'information_schema')
							and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
						group by g.rolname, n.nspname order by n.nspname`,
				]);
				const tables = new Map<string, Map<string, DbTable>>(
					schemas.map((s) => [s.name, new Map()]),
				);
				for (const r of columns) {
					const bySchema = tables.get(r.schema);
					if (!bySchema) continue;
					let t = bySchema.get(r.table);
					if (!t) {
						t = {
							name: r.table,
							kind: kinds[r.kind] ?? "table",
							rows: r.rows,
							editable: false,
							columns: [],
							foreignKeys: [],
						};
						bySchema.set(r.table, t);
					}
					if (!r.column) continue;
					const primaryKey = r.pk === true;
					t.columns.push({
						name: r.column,
						type: r.type ?? "unknown",
						nullable: r.nullable ?? true,
						default: r.default,
						primaryKey,
					});
					if (primaryKey && t.kind === "table") t.editable = true;
				}
				for (const { schema, table, columns, refColumns, ...fk } of foreignKeys)
					tables
						.get(schema)
						?.get(table)
						?.foreignKeys?.push({
							...fk,
							columns: JSON.parse(columns) as string[],
							refColumns: JSON.parse(refColumns) as string[],
						});
				const inSchema = <T extends { schema: string }>(
					rows: T[],
					name: string,
				) => rows.filter((r) => r.schema === name);
				return {
					engine: "postgres",
					database: conn.database,
					databases: databases.map((d) => d.name),
					user: conn.user,
					roles: roles.map((r) => ({
						...r,
						memberOf: JSON.parse(r.memberOf) as string[],
						grants: grants
							.filter((g) => g.role === r.name)
							.map(({ schema, privileges }) => ({
								schema,
								privileges: JSON.parse(privileges) as string[],
							})),
					})),
					schemas: [...tables].map(([name, t]) => ({
						name,
						tables: [...t.values()],
						enums: inSchema(enums, name).map((e) => ({
							name: e.name,
							values: JSON.parse(e.values) as string[],
						})),
						sequences: inSchema(sequences, name).map((q) => ({ name: q.name })),
						routines: inSchema(routines, name).map((r) => ({
							name: r.name,
							kind:
								r.kind === "p" ? ("procedure" as const) : ("function" as const),
							arguments: r.arguments,
							returns: r.returns,
						})),
					})),
				};
			} catch (e) {
				throw wrap("introspect", e);
			}
		},
		async rows(ref: TableRef, q: RowsQuery): Promise<RowsPage> {
			try {
				const table = await describe(ref, "rows");
				const names = table.columns.map((c) => c.name);
				const { keyset, offset, query } = rowsQuery(
					sql,
					ref,
					{ columns: names, key: table.key },
					q,
				);
				const result = await query.values();
				const rows = result
					.slice(0, q.limit)
					.map((r) => encodeRow(r, result.columns));
				const last = rows.at(-1);
				const more = result.length > q.limit && last;
				return {
					columns: table.columns,
					editable: table.key.length > 0,
					rows,
					nextCursor: !more
						? null
						: keyset
							? encodeCursor({
									k: table.key.map(
										(k) => cellText(last[names.indexOf(k)] ?? null) ?? "",
									),
								})
							: encodeCursor({ o: offset + q.limit }),
				};
			} catch (e) {
				throw e instanceof DatabaseError ? e : wrap("rows", e);
			}
		},
		async mutate(ref: TableRef, ops: RowPatch[]): Promise<RowsWritten> {
			try {
				const table = await describe(ref, "mutate");
				if (table.key.length === 0)
					throw new DatabaseError(
						"mutate",
						table.kind === "table"
							? `${ref.table} has no primary key, so its rows cannot be addressed`
							: `${ref.table} is a ${table.kind.replace("_", " ")}, not a table`,
						"unsupported",
					);
				const from = relation(sql, ref);
				return await sql.begin(async (tx) => {
					const rows: RowsWritten["rows"] = [];
					for (const [i, op] of ops.entries()) {
						const r = await (op.op === "insert"
							? Object.keys(op.values).length
								? tx`insert into ${from} ${insertValues(pick(table, op.values))} returning *`
								: tx`insert into ${from} default values returning *`
							: op.op === "update"
								? tx`update ${from} set ${assignments(pick(table, op.values))}
									where ${keyMatch(table, op.key)} returning *`
								: tx`delete from ${from} where ${keyMatch(table, op.key)}`
						).values();
						if (r.count !== 1)
							throw new DatabaseError(
								"mutate",
								`op ${i} (${op.op}) matched ${r.count} rows, expected 1; nothing was written`,
								"stale",
							);
						rows.push(r[0] ? encodeRow(r[0], r.columns) : null);
					}
					return { rows };
				});
			} catch (e) {
				throw e instanceof DatabaseError ? e : wrap("mutate", e);
			}
		},
		async query(script, { readOnly, signal }): Promise<QueryResult> {
			const statements = splitSql(script);
			const refused = statements.findIndex((s) =>
				TX_CONTROL.has(leadingWord(s.text)),
			);
			if (refused >= 0)
				return {
					results: [],
					error: {
						statement: refused,
						message:
							"a run is already one transaction: BEGIN, COMMIT and ROLLBACK are not supported",
					},
				};
			const results: StatementResult[] = [];
			let error: QueryError | null = null;
			let current: { cancel(): unknown } | undefined;
			const abort = () => current?.cancel();
			signal?.addEventListener("abort", abort);
			try {
				await sql.begin(readOnly ? "read only" : "", async (tx) => {
					// Takes the snapshot, so a later `set transaction read write` is refused.
					await tx`select 1`;
					for (const [i, s] of statements.entries()) {
						if (signal?.aborted) {
							error = {
								statement: i,
								message: "canceling statement due to user request",
								code: "57014",
							};
							throw signal.reason;
						}
						const started = performance.now();
						const q = tx.unsafe(s.text, [], { prepare: false }).values();
						current = q;
						// A run may `set statement_timeout = 0`; this bounds it anyway.
						const hard = setTimeout(abort, timeout + 2000);
						let batch: unknown[][] | undefined;
						try {
							const r = await q.cursor(QUERY_ROWS_LIMIT + 1, (rows) => {
								batch = rows;
								return sql.CLOSE;
							});
							// SHOW and EXPLAIN never reach the callback; their rows are the result.
							const rows = batch ?? [...r];
							const truncated = rows.length > QUERY_ROWS_LIMIT;
							results.push({
								from: s.from,
								to: s.to,
								// A cursor closed early loses the tag; the verb is the statement's.
								command: r.command ?? leadingWord(s.text).toUpperCase(),
								columns: r.columns.map((c) => ({
									name: c.name,
									type: String(c.type),
								})),
								rows: rows
									.slice(0, QUERY_ROWS_LIMIT)
									.map((row) => encodeRow(row, r.columns)),
								truncated,
								affected: truncated ? null : (r.count ?? null),
								durationMs: ms(started),
							});
						} catch (e) {
							const err = e as { code?: string; position?: string };
							if (err.code && !UNREACHABLE.has(err.code))
								error = {
									statement: i,
									message: (e as Error).message,
									code: err.code,
									...(err.position
										? { position: s.from + Number(err.position) - 1 }
										: {}),
								};
							throw e;
						} finally {
							clearTimeout(hard);
							current = undefined;
						}
					}
					// Settings a run changed stay with the pooled connection after a commit.
					await tx`reset all`;
				});
			} catch (e) {
				if (!error) throw wrap("query", e);
			} finally {
				signal?.removeEventListener("abort", abort);
			}
			await nameTypes(results);
			return { results, error };
		},
		// Outside any transaction: Postgres refuses CREATE and DROP DATABASE inside one.
		async createDatabase(name) {
			try {
				await sql.unsafe(`create database "${name.replaceAll('"', '""')}"`);
			} catch (e) {
				throw wrap("create_database", e);
			}
		},
		async dropDatabase(name) {
			try {
				// FORCE ends other sessions on it instead of failing while one is open.
				await sql.unsafe(
					`drop database "${name.replaceAll('"', '""')}" with (force)`,
				);
			} catch (e) {
				throw wrap("drop_database", e);
			}
		},
		async createRole({ name, password, login }) {
			try {
				await sql.unsafe(
					`create role ${quoteIdent(name)} ${login ? "login" : "nologin"}${password ? ` password '${scramVerifier(password)}'` : ""}`,
				);
			} catch (e) {
				throw wrap("create_role", e);
			}
		},
		async setPassword(name, _host, password) {
			if (name === conn.user)
				throw new DatabaseError(
					"set_password",
					`${name} is the explorer's own login; change it in the service's env instead`,
					"unsupported",
				);
			try {
				await sql.unsafe(
					`alter role ${quoteIdent(name)} password '${scramVerifier(password)}'`,
				);
			} catch (e) {
				throw wrap("set_password", e);
			}
		},
		close: () => sql.end({ timeout: 5 }),
	};
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
