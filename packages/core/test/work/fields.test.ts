import { describe, expect, test } from "bun:test";
import type { WorkFieldConfig } from "@logistack/contracts";
import {
	compareFieldValues,
	fieldFilterOps,
	formatFieldValue,
	parseFieldValue,
} from "../../src/work/fields.ts";

const f = (config: WorkFieldConfig) => ({ config });
const val = (config: WorkFieldConfig, raw: unknown) => {
	const r = parseFieldValue(f(config), raw);
	return r.ok ? r.value : `error: ${r.error}`;
};
const select: WorkFieldConfig = {
	kind: "select",
	options: [
		{ id: "a", label: "Alpha", color: "blue" },
		{ id: "b", label: "Beta", color: "red" },
	],
};

describe("parseFieldValue", () => {
	test("empty values become null", () => {
		expect(val({ kind: "text" }, "  ")).toBeNull();
		expect(val({ kind: "checkbox" }, false)).toBeNull();
		expect(val({ kind: "multi_select", options: [] }, [])).toBeNull();
		expect(val({ kind: "rating", max: 5, icon: "star" }, 0)).toBeNull();
	});
	test("text and long text", () => {
		expect(val({ kind: "text", maxLength: 3 }, "abcd")).toStartWith("error");
		expect(val({ kind: "text" }, "ok")).toBe("ok");
		expect(val({ kind: "long_text" }, "x".repeat(20_001))).toStartWith("error");
	});
	test("number rounds and checks bounds", () => {
		const c: WorkFieldConfig = { kind: "number", decimals: 2, min: 0, max: 10 };
		expect(val(c, "3.14159")).toBe(3.14);
		expect(val(c, 11)).toStartWith("error");
		expect(val(c, "abc")).toStartWith("error");
	});
	test("currency keeps precision as a decimal string", () => {
		const c: WorkFieldConfig = {
			kind: "currency",
			currency: "EUR",
			decimals: 2,
		};
		expect(val(c, "1234.5")).toBe("1234.50");
		expect(val(c, "0.105")).toBe("0.11");
		expect(val(c, "-2.004")).toBe("-2.00");
		expect(val(c, 0.1 + 0.2)).toBe("0.30");
		expect(val(c, "12345678901234567890.99")).toBe("12345678901234567890.99");
		expect(val(c, "1e3")).toStartWith("error");
	});
	test("percent 0–100", () => {
		expect(val({ kind: "percent", decimals: 0 }, 101)).toStartWith("error");
		expect(val({ kind: "percent", decimals: 1 }, 33.33)).toBe(33.3);
	});
	test("date with and without time", () => {
		expect(val({ kind: "date", withTime: false }, "2026-11-09T10:00:00Z")).toBe(
			"2026-11-09",
		);
		expect(
			val({ kind: "date", withTime: true }, "2026-11-09T10:00:00+01:00"),
		).toBe("2026-11-09T09:00:00.000Z");
		expect(val({ kind: "date", withTime: false }, "09/11/2026")).toStartWith(
			"error",
		);
	});
	test("unknown select options are dropped", () => {
		expect(val(select, "a")).toBe("a");
		expect(val(select, "gone")).toBeNull();
		expect(
			val({ ...select, kind: "multi_select" }, ["b", "gone", "b", "a"]),
		).toEqual(["b", "a"]);
	});
	test("user single and multiple", () => {
		expect(val({ kind: "user", multiple: false }, ["u1", "u2"])).toStartWith(
			"error",
		);
		expect(val({ kind: "user", multiple: false }, "u1")).toBe("u1");
		expect(val({ kind: "user", multiple: true }, "u1")).toEqual(["u1"]);
	});
	test("url, email, phone", () => {
		expect(val({ kind: "url" }, "javascript:alert(1)")).toStartWith("error");
		expect(val({ kind: "url" }, "https://x.dev")).toBe("https://x.dev");
		expect(val({ kind: "email" }, "nope")).toStartWith("error");
		expect(val({ kind: "phone" }, "+39 02 1234")).toBe("+39 02 1234");
	});
	test("rating bounds", () => {
		const c: WorkFieldConfig = { kind: "rating", max: 5, icon: "star" };
		expect(val(c, 5)).toBe(5);
		expect(val(c, 6)).toStartWith("error");
		expect(val(c, 2.5)).toStartWith("error");
	});
});

describe("formatFieldValue", () => {
	test("per kind", () => {
		expect(
			formatFieldValue(
				f({ kind: "currency", currency: "EUR", decimals: 2 }),
				"1234.5",
				"en",
			),
		).toBe("€1,234.50");
		expect(
			formatFieldValue(f({ kind: "number", decimals: 1, unit: "kg" }), 3, "en"),
		).toBe("3.0 kg");
		expect(
			formatFieldValue(f({ ...select, kind: "multi_select" }), ["a", "b"]),
		).toBe("Alpha; Beta");
		expect(
			formatFieldValue(
				f({ kind: "date", withTime: false }),
				"2026-11-09",
				"en",
			),
		).toBe("Nov 9, 2026");
		expect(
			formatFieldValue(f({ kind: "user", multiple: true }), ["u1"], "en", {
				u1: "Sara",
			}),
		).toBe("Sara");
		expect(formatFieldValue(f(select), null)).toBe("");
	});
});

describe("compareFieldValues", () => {
	test("numeric, empty last", () => {
		const cmp = compareFieldValues(f({ kind: "number", decimals: 0 }));
		expect([3, null, 1, 2].sort(cmp)).toEqual([1, 2, 3, null]);
	});
	test("currency compares numerically", () => {
		const cmp = compareFieldValues(
			f({ kind: "currency", currency: "EUR", decimals: 2 }),
		);
		expect(["10.00", "9.50", "100"].sort(cmp)).toEqual([
			"9.50",
			"10.00",
			"100",
		]);
	});
	test("select by option order, checkbox false < true", () => {
		expect(["b", "a"].sort(compareFieldValues(f(select)))).toEqual(["a", "b"]);
		expect(
			[true, null, false].sort(compareFieldValues(f({ kind: "checkbox" }))),
		).toEqual([null, false, true]);
	});
});

test("fieldFilterOps per kind", () => {
	expect(fieldFilterOps("rating")).toEqual([
		"eq",
		"gte",
		"lte",
		"empty",
		"not_empty",
	]);
	expect(fieldFilterOps("multi_select")).toContain("all_of");
	expect(fieldFilterOps("checkbox")).toEqual(["is"]);
});
