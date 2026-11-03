import type { DatabaseSchema, DbTable } from "@logistack/contracts";
import postgres from "postgres";
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
	});

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
		close: () => sql.end({ timeout: 5 }),
	};
}
