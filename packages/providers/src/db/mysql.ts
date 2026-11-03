import {
	type Cell,
	type DatabaseSchema,
	type DbColumn,
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
import mysql, {
	type FieldPacket,
	type PoolConnection,
	type ResultSetHeader,
	Types,
} from "mysql2";
import {
	type DatabaseClient,
	type DatabaseConnection,
	DatabaseError,
} from "./index.ts";

const UNREACHABLE = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ETIMEDOUT",
	"ECONNRESET",
	"PROTOCOL_CONNECTION_LOST",
	"PROTOCOL_SEQUENCE_TIMEOUT",
]);
const AUTH = new Set(["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR"]);
const INTERRUPTED = "ER_QUERY_INTERRUPTED";

type MysqlError = Error & { code?: string; errno?: number; fatal?: boolean };

/** The error's name; mysql2 does not know MariaDB-only ones such as 1969. */
const errorCode = (e: MysqlError) =>
	e.code ?? (e.errno === 1969 ? "ER_STATEMENT_TIMEOUT" : `ER_${e.errno}`);

function wrap(op: string, e: unknown): DatabaseError {
	if (e instanceof DatabaseError) return e;
	const err = e as MysqlError;
	const code = err.code;
	const reason =
		code && UNREACHABLE.has(code)
			? "unreachable"
			: code && AUTH.has(code)
				? "auth"
				: "query";
	return new DatabaseError(op, err.message ?? String(e), reason, code);
}

const bad = (op: string, message: string) =>
	new DatabaseError(op, message, "query");

const SYSTEM = ["mysql", "sys", "information_schema", "performance_schema"];

/** A quoted identifier: backticks, with any backtick in the name doubled. */
const ident = (name: string) => `\`${name.replaceAll("`", "``")}\``;
const relation = (ref: TableRef) => `${ident(ref.schema)}.${ident(ref.table)}`;

// A string compared with a number column is compared as a double in MySQL, which rounds past
// 2^53; a validated literal keeps bigint and decimal keys exact.
const NUMBER_TYPE =
	/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)\b/;
const NUMBER = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const BINARY_TYPE =
	/^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit)\b/;
const HEX = /^\\x((?:[0-9a-fA-F]{2})*)$/;

function hexBytes(op: string, text: string) {
	const m = HEX.exec(text);
	if (!m) throw bad(op, `${text.slice(0, 40)} is not \\x-prefixed hex`);
	return Buffer.from(m[1] ?? "", "hex");
}

/** A value bound for a column of `type`, from its text form. */
function bindText(op: string, text: string, type: string) {
	if (NUMBER_TYPE.test(type) && NUMBER.test(text)) return mysql.raw(text);
	if (BINARY_TYPE.test(type) && text.startsWith("\\x"))
		return hexBytes(op, text);
	return text;
}

function bindCell(op: string, c: Cell, type: string) {
	if (c === null || typeof c === "boolean" || typeof c === "number") return c;
	if (typeof c === "string") return bindText(op, c, type);
	if (c.type === "bytea") return hexBytes(op, c.value);
	if (c.type === "json") return c.value;
	if (!NUMBER.test(c.value)) throw bad(op, `${c.value} is not a ${c.type}`);
	return mysql.raw(c.value);
}

const BINARY_CHARSET = 63;
const NUMBERS = new Set<number>([
	Types.TINY,
	Types.SHORT,
	Types.LONG,
	Types.INT24,
	Types.YEAR,
	Types.FLOAT,
	Types.DOUBLE,
]);
const TEXTUAL = new Set<number>([
	Types.VARCHAR,
	Types.VAR_STRING,
	Types.STRING,
	Types.TINY_BLOB,
	Types.BLOB,
	Types.MEDIUM_BLOB,
	Types.LONG_BLOB,
]);

const isJson = (f: FieldPacket) =>
	f.columnType === Types.JSON || f.extendedFormat === "json";
const isBinary = (f: FieldPacket) =>
	f.columnType === Types.BIT ||
	f.columnType === Types.GEOMETRY ||
	(TEXTUAL.has(f.columnType ?? -1) &&
		f.characterSet === BINARY_CHARSET &&
		!isJson(f));

/**
 * One value from its raw text-protocol bytes, per the Cell contract: BIGINT, DECIMAL, JSON and
 * binary types (BIT, BLOB, BINARY) are tagged, small numbers are numbers, the rest is text.
 */
function cell(raw: unknown, f: FieldPacket): Cell {
	if (raw === null || raw === undefined) return null;
	const buf = raw as Buffer;
	if (isBinary(f)) return { type: "bytea", value: `\\x${buf.toString("hex")}` };
	const text = buf.toString("utf8");
	if (isJson(f)) return { type: "json", value: text };
	switch (f.columnType) {
		case Types.LONGLONG:
			return { type: "bigint", value: text };
		case Types.DECIMAL:
		case Types.NEWDECIMAL:
			return { type: "numeric", value: text };
	}
	return NUMBERS.has(f.columnType ?? -1) ? Number(text) : text;
}

const encodeRow = (row: unknown[], fields: FieldPacket[]) =>
	row.map((v, i) => cell(v, fields[i] as FieldPacket));

const TYPE_NAMES: Record<number, string> = {
	[Types.DECIMAL]: "decimal",
	[Types.NEWDECIMAL]: "decimal",
	[Types.TINY]: "tinyint",
	[Types.SHORT]: "smallint",
	[Types.LONG]: "int",
	[Types.INT24]: "mediumint",
	[Types.LONGLONG]: "bigint",
	[Types.FLOAT]: "float",
	[Types.DOUBLE]: "double",
	[Types.NULL]: "null",
	[Types.TIMESTAMP]: "timestamp",
	[Types.DATE]: "date",
	[Types.NEWDATE]: "date",
	[Types.TIME]: "time",
	[Types.DATETIME]: "datetime",
	[Types.YEAR]: "year",
	[Types.BIT]: "bit",
	[Types.JSON]: "json",
	[Types.ENUM]: "enum",
	[Types.SET]: "set",
	[Types.GEOMETRY]: "geometry",
	[Types.VARCHAR]: "varchar",
	[Types.VAR_STRING]: "varchar",
	[Types.STRING]: "char",
	[Types.TINY_BLOB]: "text",
	[Types.BLOB]: "text",
	[Types.MEDIUM_BLOB]: "text",
	[Types.LONG_BLOB]: "text",
};

function typeName(f: FieldPacket) {
	if (isJson(f)) return "json";
	const name = TYPE_NAMES[f.columnType ?? -1] ?? "unknown";
	if (f.characterSet !== BINARY_CHARSET || !TEXTUAL.has(f.columnType ?? -1))
		return name;
	return name === "text" ? "blob" : name === "char" ? "binary" : "varbinary";
}

const kindOf = (tableType: string): DbTable["kind"] =>
	tableType === "VIEW" ? "view" : "table";

type ColumnRow = {
	schema: string;
	table: string;
	kind: string;
	rows: string | number | null;
	column: string | null;
	type: string | null;
	nullable: number | null;
	default: string | null;
	extra: string | null;
	key: number | null;
};

const COLUMNS = `
	select t.TABLE_SCHEMA as \`schema\`, t.TABLE_NAME as \`table\`, t.TABLE_TYPE as kind,
		t.TABLE_ROWS as \`rows\`, c.COLUMN_NAME as \`column\`, c.COLUMN_TYPE as type,
		c.IS_NULLABLE = 'YES' as nullable, c.COLUMN_DEFAULT as \`default\`, c.EXTRA as extra,
		s.SEQ_IN_INDEX as \`key\`
	from information_schema.TABLES t
	left join information_schema.COLUMNS c
		on c.TABLE_SCHEMA = t.TABLE_SCHEMA and c.TABLE_NAME = t.TABLE_NAME
	left join information_schema.STATISTICS s
		on s.TABLE_SCHEMA = c.TABLE_SCHEMA and s.TABLE_NAME = c.TABLE_NAME
		and s.COLUMN_NAME = c.COLUMN_NAME and s.INDEX_NAME = 'PRIMARY'`;

type Flavor = "mysql" | "mariadb";

function column(r: ColumnRow, flavor: Flavor): DbColumn {
	// MariaDB reports "no default" as the text NULL.
	const d = flavor === "mariadb" && r.default === "NULL" ? null : r.default;
	return {
		name: r.column ?? "",
		type: r.type ?? "unknown",
		nullable: r.nullable === 1,
		default:
			d ?? (r.extra?.includes("auto_increment") ? "auto_increment" : null),
		primaryKey: r.key !== null,
	};
}

type Table = {
	kind: DbTable["kind"];
	columns: DbColumn[];
	key: string[];
	/** The AUTO_INCREMENT column, whose inserted value is the insert id. */
	auto: string | null;
};

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

const cellText = (c: Cell) =>
	c === null ? null : typeof c === "object" ? c.value : String(c);

// A run is one transaction the explorer owns, so statements that end or open one are refused.
const TX_CONTROL = new Set(["begin", "start", "commit", "rollback", "xa"]);

const ms = (since: number) => Math.round((performance.now() - since) * 10) / 10;

type Streamed = {
	fields: FieldPacket[] | undefined;
	rows: unknown[][];
	header: ResultSetHeader | undefined;
	truncated: boolean;
};

/** MySQL 8.x and MariaDB 10.11+/11.x over mysql2, which reports column metadata for every result. */
export function mysqlClient(conn: DatabaseConnection): DatabaseClient {
	const timeout = conn.statementTimeoutMs ?? 30_000;
	const options = {
		host: conn.host,
		port: conn.port,
		user: conn.user,
		password: conn.password,
		database: conn.database || undefined,
		connectTimeout: 5000,
		supportBigNumbers: true,
		bigNumberStrings: true,
		dateStrings: true,
		decimalNumbers: false,
		multipleStatements: false,
		// caching_sha2_password over plain TCP: mysql2 asks the server for its RSA key on its own.
		// The hop is the private ls-db overlay.
	};
	const pool = mysql.createPool({
		...options,
		connectionLimit: 4,
		maxIdle: 1,
		idleTimeout: 300_000,
	});
	let flavor: Flavor | undefined;
	const ready = new WeakSet<PoolConnection>();

	const run = <T>(c: PoolConnection, sql: string, values: unknown[] = []) =>
		new Promise<T>((resolve, reject) =>
			c.query(sql, values, (e, r) => (e ? reject(e) : resolve(r as T))),
		);

	/** A pooled connection with the statement timeout set for its engine. */
	async function acquire(): Promise<PoolConnection> {
		const c = await new Promise<PoolConnection>((resolve, reject) =>
			pool.getConnection((e, c) => (e ? reject(e) : resolve(c))),
		);
		if (ready.has(c)) return c;
		try {
			if (!flavor) {
				const [v] = await run<{ v: string }[]>(c, "select version() as v");
				flavor = /mariadb/i.test(v?.v ?? "") ? "mariadb" : "mysql";
			}
			// MySQL bounds SELECTs only; MariaDB bounds every statement. Row estimates read live.
			await run(
				c,
				flavor === "mariadb"
					? `set session max_statement_time = ${timeout / 1000}`
					: `set session max_execution_time = ${timeout}, information_schema_stats_expiry = 0`,
			);
			ready.add(c);
			return c;
		} catch (e) {
			c.destroy();
			throw e;
		}
	}

	async function using<T>(op: string, fn: (c: PoolConnection) => Promise<T>) {
		let c: PoolConnection | undefined;
		try {
			c = await acquire();
			return await fn(c);
		} catch (e) {
			throw wrap(op, e);
		} finally {
			c?.release();
		}
	}

	/** Stops the statement running on `threadId`, from a connection of its own. */
	async function kill(threadId: number | null) {
		if (threadId === null) return;
		const k = mysql.createConnection(options);
		try {
			await new Promise<void>((resolve) =>
				k.query(`kill query ${Number(threadId)}`, () => resolve()),
			);
		} finally {
			k.destroy();
		}
	}

	/**
	 * Runs one statement, keeping the first result set and at most `cap` rows of it as raw bytes.
	 * Past the cap it calls `onCap` and drops the rest, so a huge result never sits in memory.
	 */
	function stream(
		c: PoolConnection,
		sql: string,
		values: unknown[],
		cap: number,
		onCap: () => void = () => {},
	) {
		return new Promise<Streamed>((resolve, reject) => {
			const out: Streamed = {
				fields: undefined,
				rows: [],
				header: undefined,
				truncated: false,
			};
			let sets = 0;
			c.query({
				sql,
				values,
				rowsAsArray: true,
				typeCast: (f) => f.buffer(),
			})
				.on("fields", (fields: FieldPacket[] | undefined) => {
					if (++sets === 1) out.fields = fields;
				})
				.on("result", (row: unknown) => {
					if (sets !== 1) return;
					if (!out.fields) out.header = row as ResultSetHeader;
					else if (out.rows.length < cap) out.rows.push(row as unknown[]);
					else if (!out.truncated) {
						out.truncated = true;
						onCap();
					}
				})
				.on("error", (e: MysqlError) =>
					out.truncated && e.code === INTERRUPTED ? resolve(out) : reject(e),
				)
				.on("end", () => resolve(out));
		});
	}

	async function describe(
		c: PoolConnection,
		ref: TableRef,
		op: string,
	): Promise<Table> {
		const rows = await run<ColumnRow[]>(
			c,
			`${COLUMNS} where t.TABLE_SCHEMA = ? and t.TABLE_NAME = ? order by c.ORDINAL_POSITION`,
			[ref.schema, ref.table],
		);
		const first = rows[0];
		if (!first?.column)
			throw new DatabaseError(
				op,
				`${ref.schema}.${ref.table} does not exist`,
				"missing",
			);
		const kind = kindOf(first.kind);
		return {
			kind,
			columns: rows.map((r) => column(r, flavor ?? "mysql")),
			key:
				kind === "table"
					? rows
							.filter((r) => r.key !== null)
							.sort((a, b) => (a.key ?? 0) - (b.key ?? 0))
							.map((r) => r.column ?? "")
					: [],
			auto:
				rows.find((r) => r.extra?.includes("auto_increment"))?.column ?? null,
		};
	}

	const typeOf = (table: Table, name: string) => {
		const col = table.columns.find((c) => c.name === name);
		if (!col) throw bad("mutate", `unknown column ${name}`);
		return col.type;
	};

	function filterSql(table: Table, f: RowFilter, values: unknown[]) {
		const col = ident(f.column);
		if (f.op === "is_null") return `${col} is null`;
		if (f.op === "not_null") return `${col} is not null`;
		const v = f.value;
		if (v === undefined) throw bad("rows", `filter ${f.op} needs a value`);
		if (f.op === "contains" || f.op === "starts_with") {
			// Byte-wise, so the match is case-sensitive and literal like Postgres's strpos.
			values.push(v);
			return `instr(cast(${col} as binary), cast(? as binary)) ${f.op === "contains" ? "> 0" : "= 1"}`;
		}
		values.push(bindText("rows", v, typeOf(table, f.column)));
		const op = { eq: "=", neq: "<>", lt: "<", gt: ">", lte: "<=", gte: ">=" }[
			f.op
		];
		return `${col} ${op} ?`;
	}

	/** The row a write left behind, read back by its key; MySQL has no RETURNING. */
	async function readBack(
		c: PoolConnection,
		ref: TableRef,
		table: Table,
		key: Record<string, unknown>,
	) {
		const values: unknown[] = [];
		const where = table.key.map((k) => {
			values.push(key[k]);
			return `${ident(k)} = ?`;
		});
		const r = await stream(
			c,
			`select * from ${relation(ref)} where ${where.join(" and ")}`,
			values,
			1,
		);
		const row = r.rows[0];
		return row && r.fields ? encodeRow(row, r.fields) : null;
	}

	function keyMatch(
		table: Table,
		key: Record<string, Cell>,
		values: unknown[],
	) {
		const names = Object.keys(key);
		if (
			names.length !== table.key.length ||
			!table.key.every((k) => names.includes(k))
		)
			throw bad(
				"mutate",
				`key must be exactly the primary key (${table.key.join(", ")})`,
			);
		return table.key
			.map((k) => {
				values.push(bindCell("mutate", key[k] ?? null, typeOf(table, k)));
				return `${ident(k)} = ?`;
			})
			.join(" and ");
	}

	return {
		introspect: () =>
			using("introspect", async (c) => {
				const system = SYSTEM.map(() => "?").join(", ");
				const schemas = await run<{ name: string }[]>(
					c,
					`select SCHEMA_NAME as name from information_schema.SCHEMATA
					where SCHEMA_NAME not in (${system}) order by SCHEMA_NAME`,
					SYSTEM,
				);
				const columns = await run<ColumnRow[]>(
					c,
					`${COLUMNS} where t.TABLE_SCHEMA not in (${system})
					order by t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION`,
					SYSTEM,
				);
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
							kind: kindOf(r.kind),
							rows: r.rows === null ? null : Number(r.rows),
							editable: false,
							columns: [],
						};
						bySchema.set(r.table, t);
					}
					if (!r.column) continue;
					const col = column(r, flavor ?? "mysql");
					t.columns.push(col);
					if (col.primaryKey && t.kind === "table") t.editable = true;
				}
				return {
					engine: conn.engine,
					database: conn.database || conn.engine,
					schemas: [...tables].map(([name, t]) => ({
						name,
						tables: [...t.values()],
					})),
				} satisfies DatabaseSchema;
			}),

		rows: (ref: TableRef, q: RowsQuery): Promise<RowsPage> =>
			using("rows", async (c) => {
				const table = await describe(c, ref, "rows");
				const names = table.columns.map((col) => col.name);
				for (const { column } of [...q.sort, ...q.filter])
					if (!names.includes(column))
						throw bad("rows", `unknown column ${column}`);
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

				const values: unknown[] = [];
				const where = q.filter.map((f) => filterSql(table, f, values));
				if (cursor && "k" in cursor) {
					if (cursor.k.length !== key.length)
						throw bad("rows", "invalid cursor");
					where.push(
						`(${key.map(ident).join(", ")}) ${desc ? "<" : ">"} (${key.map(() => "?").join(", ")})`,
					);
					key.forEach((k, i) => {
						values.push(bindText("rows", cursor.k[i] ?? "", typeOf(table, k)));
					});
				}
				const offset = cursor && "o" in cursor ? cursor.o : 0;
				const order = sort.length
					? `order by ${sort.map((s) => `${ident(s.column)} ${s.desc ? "desc" : "asc"}`).join(", ")}`
					: "";
				const r = await stream(
					c,
					`select * from ${relation(ref)} ${where.length ? `where ${where.join(" and ")}` : ""}
					${order} limit ${q.limit + 1} offset ${offset}`,
					values,
					q.limit + 1,
				);
				const fields = r.fields ?? [];
				const rows = r.rows
					.slice(0, q.limit)
					.map((row) => encodeRow(row, fields));
				const last = rows.at(-1);
				const more = r.rows.length > q.limit && last;
				return {
					columns: table.columns,
					editable: key.length > 0,
					rows,
					nextCursor: !more
						? null
						: keyset
							? encodeCursor({
									k: key.map(
										(k) => cellText(last[names.indexOf(k)] ?? null) ?? "",
									),
								})
							: encodeCursor({ o: offset + q.limit }),
				};
			}),

		mutate: (ref: TableRef, ops: RowPatch[]): Promise<RowsWritten> =>
			using("mutate", async (c) => {
				const table = await describe(c, ref, "mutate");
				if (table.key.length === 0)
					throw new DatabaseError(
						"mutate",
						table.kind === "table"
							? `${ref.table} has no primary key, so its rows cannot be addressed`
							: `${ref.table} is a ${table.kind}, not a table`,
						"unsupported",
					);
				const from = relation(ref);
				const bindAll = (vals: Record<string, Cell>) =>
					Object.entries(vals).map(([n, v]) => ({
						name: n,
						value: bindCell("mutate", v, typeOf(table, n)),
					}));
				await run(c, "start transaction");
				try {
					const rows: RowsWritten["rows"] = [];
					for (const [i, op] of ops.entries()) {
						const values: unknown[] = [];
						if (op.op === "insert") {
							const cols = bindAll(op.values);
							values.push(...cols.map((x) => x.value));
							const h = await run<ResultSetHeader>(
								c,
								`insert into ${from} (${cols.map((x) => ident(x.name)).join(", ")})
								values (${cols.map(() => "?").join(", ")})`,
								values,
							);
							const given = Object.fromEntries(
								cols.map((x) => [x.name, x.value]),
							);
							const key = Object.fromEntries(
								table.key.map((k) => [
									k,
									k in given
										? given[k]
										: k === table.auto
											? mysql.raw(String(h.insertId))
											: undefined,
								]),
							);
							rows.push(
								Object.values(key).includes(undefined)
									? null
									: await readBack(c, ref, table, key),
							);
							continue;
						}
						const where =
							op.op === "update"
								? (() => {
										const set = bindAll(op.values);
										values.push(...set.map((x) => x.value));
										return `update ${from} set ${set.map((x) => `${ident(x.name)} = ?`).join(", ")}`;
									})()
								: `delete from ${from}`;
						const h = await run<ResultSetHeader>(
							c,
							`${where} where ${keyMatch(table, op.key, values)}`,
							values,
						);
						// The client sets FOUND_ROWS, so this counts matched rows, changed or not.
						if (h.affectedRows !== 1)
							throw new DatabaseError(
								"mutate",
								`op ${i} (${op.op}) matched ${h.affectedRows} rows, expected 1; nothing was written`,
								"stale",
							);
						if (op.op === "delete") rows.push(null);
						else {
							const next = { ...op.key, ...op.values };
							rows.push(
								await readBack(
									c,
									ref,
									table,
									Object.fromEntries(
										table.key.map((k) => [
											k,
											bindCell("mutate", next[k] ?? null, typeOf(table, k)),
										]),
									),
								),
							);
						}
					}
					await run(c, "commit");
					return { rows };
				} catch (e) {
					await run(c, "rollback").catch(() => {});
					throw e;
				}
			}),

		async query(script, { readOnly, signal }): Promise<QueryResult> {
			const statements = splitSql(script, "mysql");
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
			let c: PoolConnection | undefined;
			try {
				c = await acquire();
				const conn = c;
				// The session default too, so a statement that commits implicitly (DDL) cannot
				// leave the next ones writable.
				if (readOnly) await run(conn, "set session transaction read only");
				await run(
					conn,
					readOnly ? "start transaction read only" : "start transaction",
				);
				for (const [i, s] of statements.entries()) {
					let timedOut = false;
					// Why the run stopped this statement, if it did.
					const stopped = (): QueryError | null =>
						timedOut
							? {
									statement: i,
									message: `the statement ran past the ${timeout / 1000} s timeout`,
									code: "ER_QUERY_TIMEOUT",
								}
							: signal?.aborted
								? {
										statement: i,
										message: "Query execution was interrupted",
										code: INTERRUPTED,
									}
								: null;
					error = stopped();
					if (error) break;
					const started = performance.now();
					let stopping: Promise<void> | undefined;
					const stop = () => {
						stopping ??= kill(conn.threadId);
					};
					signal?.addEventListener("abort", stop);
					// MySQL's max_execution_time bounds SELECTs only, and a run may reset either limit.
					const hard = setTimeout(() => {
						timedOut = true;
						stop();
					}, timeout + 2000);
					try {
						const r = await stream(conn, s.text, [], QUERY_ROWS_LIMIT, stop);
						await stopping;
						// SLEEP() returns 1 instead of failing when it is interrupted.
						error = stopped();
						if (error) break;
						const fields = r.fields ?? [];
						results.push({
							from: s.from,
							to: s.to,
							command: leadingWord(s.text).toUpperCase(),
							columns: fields.map((f) => ({ name: f.name, type: typeName(f) })),
							rows: r.rows.map((row) => encodeRow(row, fields)),
							truncated: r.truncated,
							affected: r.truncated
								? null
								: r.fields
									? r.rows.length
									: (r.header?.affectedRows ?? null),
							durationMs: ms(started),
						});
					} catch (e) {
						await stopping;
						const err = e as MysqlError;
						if (
							err.fatal ||
							err.errno === undefined ||
							UNREACHABLE.has(err.code ?? "")
						)
							throw e;
						error = stopped() ?? {
							statement: i,
							message: err.message,
							code: errorCode(err),
						};
						break;
					} finally {
						clearTimeout(hard);
						signal?.removeEventListener("abort", stop);
					}
				}
				await run(conn, error ? "rollback" : "commit");
			} catch (e) {
				throw wrap("query", e);
			} finally {
				// Whatever the run changed in its session (sql_mode, variables) dies with it.
				c?.destroy();
			}
			return { results, error };
		},

		close: () => new Promise<void>((resolve) => pool.end(() => resolve())),
	};
}
