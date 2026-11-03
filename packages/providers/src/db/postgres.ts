import type {
	Cell,
	DatabaseSchema,
	DbColumn,
	DbTable,
	RowFilter,
	RowPatch,
	RowsPage,
	RowsQuery,
	RowsWritten,
	TableRef,
} from "@logistack/contracts";
import postgres, { type PendingQuery, type Row, type Sql } from "postgres";
import { type DatabaseConnection, DatabaseError } from "./index.ts";

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

function wrap(op: string, e: unknown): DatabaseError {
	const err = e as { code?: string; errno?: string; message?: string };
	const code = err.code ?? err.errno;
	const reason =
		code && UNREACHABLE.has(code)
			? "unreachable"
			: code && AUTH.has(code)
				? "auth"
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

// postgres.js splits identifiers on dots, so such a name would address something else.
function checkName(name: string) {
	if (name.includes("."))
		throw new DatabaseError(
			"rows",
			`names containing a dot are not supported: ${name}`,
			"unsupported",
		);
}

// Its own fragment, so a keyword earlier in the query never turns it into an insert/update builder.
function ident(sql: Sql, name: string) {
	checkName(name);
	return sql`${sql(name)}`;
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

export function postgresClient(conn: DatabaseConnection) {
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
		connection: { application_name: "logistack-explorer" },
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
			checkName(name);
			out[name] = cellText(v);
		}
		return out;
	};

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
		async introspect(): Promise<DatabaseSchema> {
			try {
				const [schemas, columns] = await Promise.all([
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
				return {
					engine: "postgres",
					database: conn.database,
					schemas: [...tables].map(([name, t]) => ({
						name,
						tables: [...t.values()],
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
								? tx`insert into ${from} ${tx(pick(table, op.values))} returning *`
								: tx`insert into ${from} default values returning *`
							: op.op === "update"
								? tx`update ${from} set ${tx(pick(table, op.values))}
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
		close: () => sql.end({ timeout: 5 }),
	};
}
