import type { Cell, DbColumn, RowPatch } from "@logistack/contracts";

export type Values = Record<string, Cell>;

/** Edits staged on one table until Save sends them as one batch. */
export type Staged = {
	/** By row key: the row's full primary key and the columns changed. */
	edits: Record<string, { key: Values; values: Values }>;
	deletes: Record<string, Values>;
	inserts: { id: string; values: Values }[];
};

export const EMPTY_STAGED: Staged = { edits: {}, deletes: {}, inserts: [] };

/** A cell as the engine writes it: tagged values show their own text. */
export function cellText(cell: Cell): string {
	if (cell === null) return "";
	if (typeof cell === "object") return cell.value;
	return String(cell);
}

export const sameCell = (a: Cell, b: Cell) =>
	JSON.stringify(a) === JSON.stringify(b);

/** Postgres's `format_type` names, shortened for a column header. */
const SHORT: [RegExp, string][] = [
	[/^character varying/, "varchar"],
	[/^character\b/, "char"],
	[/^timestamp(\(\d\))? with time zone/, "timestamptz$1"],
	[/^timestamp(\(\d\))? without time zone/, "timestamp$1"],
	[/^time(\(\d\))? with time zone/, "timetz$1"],
	[/^time(\(\d\))? without time zone/, "time$1"],
	[/^double precision/, "float8"],
];
export const shortType = (type: string) =>
	SHORT.reduce((t, [re, to]) => t.replace(re, to), type);

const base = (type: string) => type.replace(/\(.*?\)/, "");
const INTEGER = new Set(["smallint", "integer", "oid"]);
const FLOAT = new Set(["real", "double precision"]);
const TAGGED: Record<string, "bigint" | "numeric" | "bytea" | "json"> = {
	bigint: "bigint",
	numeric: "numeric",
	bytea: "bytea",
	json: "json",
	jsonb: "json",
};

/** Right-aligned, tabular columns. */
export function isNumeric(type: string) {
	const t = base(type);
	return INTEGER.has(t) || FLOAT.has(t) || t === "bigint" || t === "numeric";
}

/**
 * The cell an edit writes. A tagged original keeps its tag; otherwise the column type picks
 * the JSON shape the api expects, and anything else stays text for the engine to parse.
 */
export function fromText(text: string, column: DbColumn, original: Cell): Cell {
	if (original !== null && typeof original === "object")
		return { type: original.type, value: text };
	const t = base(column.type);
	const tag = TAGGED[t];
	if (tag) return { type: tag, value: text };
	if (t === "boolean" && (text === "true" || text === "false"))
		return text === "true";
	if ((INTEGER.has(t) || FLOAT.has(t)) && text.trim() !== "") {
		const n = Number(text);
		if (Number.isFinite(n)) return n;
	}
	return text;
}

export const keyOf = (columns: DbColumn[], row: Cell[]): Values =>
	Object.fromEntries(
		columns.flatMap((c, i) => (c.primaryKey ? [[c.name, row[i] ?? null]] : [])),
	);

export const rowKey = (key: Values) => JSON.stringify(key);

/** Stage one cell's new value; setting it back to the original drops the edit. */
export function stageEdit(
	staged: Staged,
	key: Values,
	column: string,
	value: Cell,
	original: Cell,
): Staged {
	const id = rowKey(key);
	const values = { ...staged.edits[id]?.values };
	if (sameCell(value, original)) delete values[column];
	else values[column] = value;
	const edits = { ...staged.edits };
	if (Object.keys(values).length) edits[id] = { key, values };
	else delete edits[id];
	return { ...staged, edits };
}

/** Updates, then deletes, then inserts; an edited row that is also deleted is only deleted. */
export function toOps(staged: Staged): RowPatch[] {
	return [
		...Object.entries(staged.edits)
			.filter(([id]) => !(id in staged.deletes))
			.map(([, e]): RowPatch => ({ op: "update", ...e })),
		...Object.values(staged.deletes).map(
			(key): RowPatch => ({ op: "delete", key }),
		),
		...staged.inserts.map(
			(r): RowPatch => ({ op: "insert", values: r.values }),
		),
	];
}

/** A header click: none, ascending, descending, none. Shift keeps the other columns. */
export function nextSort(
	sort: { column: string; desc: boolean }[],
	column: string,
	multi: boolean,
) {
	const cur = sort.find((s) => s.column === column);
	const step = !cur
		? { column, desc: false }
		: cur.desc
			? null
			: { column, desc: true };
	if (!multi) return step ? [step] : [];
	if (!step) return sort.filter((s) => s.column !== column);
	return cur
		? sort.map((s) => (s.column === column ? step : s))
		: [...sort, step];
}
