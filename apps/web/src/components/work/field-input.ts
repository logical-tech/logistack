/* Text in, field value out: the pure half of FieldEditor (tested on its own). */
import type { WorkField } from "@logistack/contracts";
import { parseFieldValue } from "@logistack/core/work";
import { parseDayInput } from "./pickers";

/** Kinds edited by typing into a text box. */
export const TEXT_KINDS = new Set([
	"text",
	"long_text",
	"number",
	"currency",
	"percent",
	"date",
	"url",
	"email",
	"phone",
]);

/** The text a typed field starts with. */
export function fieldText(field: WorkField, value: unknown): string {
	if (value === null || value === undefined) return "";
	if (field.config.kind === "date" && typeof value === "string")
		return value.length > 10 ? value.slice(0, 16).replace("T", " ") : value;
	return String(value);
}

export type FieldCommit =
	| { ok: true; value: unknown }
	| { ok: false; error: string };

/**
 * Parses what someone typed for a field. Empty text clears the value. Dates accept plain words
 * ("next fri"); URLs without a scheme get `https://`. Errors read as "Enter …".
 */
export function commitFieldText(field: WorkField, text: string): FieldCommit {
	const t = text.trim();
	if (!t) return { ok: true, value: null };
	let raw: unknown = t;
	const c = field.config;
	if (c.kind === "date") {
		const [day, time] = t.split(/\s+(?=\d{1,2}:\d{2}$)/);
		const iso = /^\d{4}-\d{2}-\d{2}$/.test(day ?? "")
			? (day as string)
			: parseDayInput(day ?? "");
		if (!iso)
			return { ok: false, error: "Enter a date, like “fri” or “12 dec”" };
		raw =
			c.withTime && time
				? new Date(`${iso}T${time.padStart(5, "0")}`).toISOString()
				: iso;
	}
	if (c.kind === "url" && !/^[a-z]+:\/\//i.test(t)) raw = `https://${t}`;
	if (c.kind === "percent") raw = t.replace(/%$/, "").trim();
	if (c.kind === "currency") raw = t.replace(/[^\d.,-]/g, "").replace(",", ".");
	const parsed = parseFieldValue(field, raw);
	return parsed.ok
		? { ok: true, value: parsed.value }
		: { ok: false, error: `Enter ${parsed.error}` };
}
