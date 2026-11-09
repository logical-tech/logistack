import {
	type FilterOp,
	type WorkFieldConfig,
	type WorkFieldKind,
	type WorkFieldValue,
	workFieldValueSchemas,
} from "@logistack/contracts";

/** The parts of a `work_field` row the value rules need. */
export type FieldDef = { id?: string; config: WorkFieldConfig };

export type FieldParse =
	| { ok: true; value: WorkFieldValue | null }
	| { ok: false; error: string };

const ok = (value: WorkFieldValue | null): FieldParse => ({ ok: true, value });
const fail = (error: string): FieldParse => ({ ok: false, error });

const isEmpty = (raw: unknown) =>
	raw === null ||
	raw === undefined ||
	(typeof raw === "string" && raw.trim() === "") ||
	(Array.isArray(raw) && raw.length === 0);

/** Round a decimal string half away from zero to `d` places without floats. */
function roundDecimal(s: string, d: number): string {
	const neg = s.startsWith("-");
	const [int = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
	let digits = BigInt(int + frac.padEnd(d, "0").slice(0, d));
	if (frac.length > d && Number(frac[d]) >= 5) digits += 1n;
	const str = digits.toString().padStart(d + 1, "0");
	const out = d ? `${str.slice(0, -d)}.${str.slice(-d)}` : str;
	return neg && digits !== 0n ? `-${out}` : out;
}

const toNumber = (raw: unknown): number | null => {
	const n = typeof raw === "string" ? Number(raw.trim()) : raw;
	return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const roundTo = (n: number, d: number) => Number(n.toFixed(d));

/**
 * Validate and normalise a raw value for a field. Empty values return `null` (the row is deleted).
 * Unknown select options are dropped, so readers can also use it to clean stored values.
 */
export function parseFieldValue(field: FieldDef, raw: unknown): FieldParse {
	const c = field.config;
	if (isEmpty(raw)) return ok(null);
	switch (c.kind) {
		case "text": {
			const s = workFieldValueSchemas.text.safeParse(raw);
			if (!s.success) return fail("text expected (≤ 2000 chars)");
			if (c.maxLength && s.data.length > c.maxLength)
				return fail(`at most ${c.maxLength} characters`);
			return ok(s.data);
		}
		case "long_text": {
			const s = workFieldValueSchemas.long_text.safeParse(raw);
			return s.success ? ok(s.data) : fail("text expected (≤ 20000 chars)");
		}
		case "number": {
			const n = toNumber(raw);
			if (n === null) return fail("a number");
			if (c.min !== undefined && n < c.min) return fail(`at least ${c.min}`);
			if (c.max !== undefined && n > c.max) return fail(`at most ${c.max}`);
			return ok(roundTo(n, c.decimals));
		}
		case "percent": {
			const n = toNumber(raw);
			if (n === null || n < 0 || n > 100) return fail("a percentage 0–100");
			return ok(roundTo(n, c.decimals));
		}
		case "currency": {
			const s =
				typeof raw === "number" && Number.isFinite(raw)
					? raw.toFixed(c.decimals + 1)
					: String(raw).trim();
			if (!workFieldValueSchemas.currency.safeParse(s).success)
				return fail("an amount such as 1234.50");
			return ok(roundDecimal(s, c.decimals));
		}
		case "date": {
			const s = workFieldValueSchemas.date.safeParse(raw);
			if (!s.success) return fail("a date (YYYY-MM-DD) or datetime");
			if (!c.withTime) return ok(s.data.slice(0, 10));
			return ok(s.data.length === 10 ? s.data : new Date(s.data).toISOString());
		}
		case "checkbox":
			if (typeof raw !== "boolean") return fail("true or false");
			return ok(raw ? true : null);
		case "select": {
			if (typeof raw !== "string") return fail("an option id");
			return ok(c.options.some((o) => o.id === raw) ? raw : null);
		}
		case "multi_select": {
			if (!Array.isArray(raw)) return fail("a list of option ids");
			const known = new Set(c.options.map((o) => o.id));
			const ids = [...new Set(raw)].filter(
				(v): v is string => typeof v === "string" && known.has(v),
			);
			return ok(ids.length ? ids : null);
		}
		case "user": {
			const list = Array.isArray(raw) ? raw : [raw];
			if (!list.every((v) => typeof v === "string" && v))
				return fail("user ids");
			const ids = [...new Set(list as string[])];
			if (!c.multiple && ids.length > 1) return fail("a single user");
			return ok(c.multiple ? ids : (ids[0] as string));
		}
		case "url": {
			const s = workFieldValueSchemas.url.safeParse(
				typeof raw === "string" ? raw.trim() : raw,
			);
			return s.success ? ok(s.data) : fail("an http(s) URL");
		}
		case "email": {
			const s = workFieldValueSchemas.email.safeParse(
				typeof raw === "string" ? raw.trim() : raw,
			);
			return s.success ? ok(s.data) : fail("an email address");
		}
		case "phone": {
			if (typeof raw !== "string" || !/^\+?[\d\s().-]{3,40}$/.test(raw.trim()))
				return fail("a phone number");
			return ok(raw.trim());
		}
		case "rating": {
			const n = toNumber(raw);
			if (n === null || !Number.isInteger(n) || n < 0 || n > c.max)
				return fail(`a whole number 0–${c.max}`);
			return ok(n === 0 ? null : n);
		}
	}
}

/** Human text for a stored value; `""` when empty. `names` maps user ids to display names. */
export function formatFieldValue(
	field: FieldDef,
	value: unknown,
	locale = "en",
	names: Record<string, string> = {},
): string {
	const parsed = parseFieldValue(field, value);
	if (!parsed.ok || parsed.value === null) return "";
	const v = parsed.value;
	const c = field.config;
	const num = (d: number, extra: Intl.NumberFormatOptions = {}) =>
		new Intl.NumberFormat(locale, {
			minimumFractionDigits: d,
			maximumFractionDigits: d,
			...extra,
		});
	switch (c.kind) {
		case "number":
			return `${num(c.decimals).format(v as number)}${c.unit ? ` ${c.unit}` : ""}`;
		case "percent":
			return `${num(c.decimals).format(v as number)}%`;
		case "currency":
			return num(c.decimals, {
				style: "currency",
				currency: c.currency,
			}).format(Number(v));
		case "date": {
			const s = v as string;
			const withTime = s.length > 10;
			return new Intl.DateTimeFormat(locale, {
				dateStyle: "medium",
				...(withTime ? { timeStyle: "short" } : { timeZone: "UTC" }),
			}).format(new Date(withTime ? s : `${s}T00:00:00Z`));
		}
		case "checkbox":
			return "Yes";
		case "select":
			return c.options.find((o) => o.id === v)?.label ?? "";
		case "multi_select":
			return (v as string[])
				.map((id) => c.options.find((o) => o.id === id)?.label)
				.filter(Boolean)
				.join("; ");
		case "user":
			return (Array.isArray(v) ? v : [v as string])
				.map((id) => names[id] ?? id)
				.join("; ");
		case "rating":
			return `${v}/${c.max}`;
		default:
			return String(v);
	}
}

/** Sort comparator for a field's values; empty values always last. */
export function compareFieldValues(
	field: FieldDef,
): (a: unknown, b: unknown) => number {
	const c = field.config;
	const optionIndex = (id: unknown) =>
		c.kind === "select" || c.kind === "multi_select"
			? c.options.findIndex((o) => o.id === id)
			: -1;
	const key = (v: unknown): number | string | null => {
		const p = parseFieldValue(field, v);
		if (!p.ok) return null;
		const x = p.value;
		if (c.kind === "checkbox") return x ? 1 : 0;
		if (x === null) return null;
		switch (c.kind) {
			case "number":
			case "percent":
			case "rating":
				return x as number;
			case "currency":
				return Number(x);
			case "select":
				return optionIndex(x);
			case "multi_select":
				return Math.min(...(x as string[]).map(optionIndex));
			case "user":
				return Array.isArray(x) ? (x[0] ?? "") : (x as string);
			case "long_text":
				return 0;
			default:
				return String(x).toLowerCase();
		}
	};
	return (a, b) => {
		const ka = key(a);
		const kb = key(b);
		if (ka === null || kb === null) return ka === kb ? 0 : ka === null ? 1 : -1;
		if (typeof ka === "number" && typeof kb === "number") return ka - kb;
		return String(ka).localeCompare(String(kb));
	};
}

const OPS: Record<WorkFieldKind, FilterOp[]> = {
	text: ["contains", "is", "empty", "not_empty"],
	long_text: ["contains", "empty", "not_empty"],
	number: [
		"eq",
		"neq",
		"lt",
		"lte",
		"gt",
		"gte",
		"between",
		"empty",
		"not_empty",
	],
	currency: [
		"eq",
		"neq",
		"lt",
		"lte",
		"gt",
		"gte",
		"between",
		"empty",
		"not_empty",
	],
	percent: [
		"eq",
		"neq",
		"lt",
		"lte",
		"gt",
		"gte",
		"between",
		"empty",
		"not_empty",
	],
	date: ["before", "after", "on", "between", "relative", "empty", "not_empty"],
	checkbox: ["is"],
	select: ["is", "is_not", "any_of", "none_of", "empty", "not_empty"],
	multi_select: ["any_of", "all_of", "none_of", "empty", "not_empty"],
	user: ["is", "is_not", "any_of", "none_of", "empty", "not_empty"],
	url: ["contains", "empty", "not_empty"],
	email: ["contains", "empty", "not_empty"],
	phone: ["contains", "empty", "not_empty"],
	rating: ["eq", "gte", "lte", "empty", "not_empty"],
};

/** Filter operators a field kind supports (section 4.3). */
export const fieldFilterOps = (kind: WorkFieldKind): readonly FilterOp[] =>
	OPS[kind];
