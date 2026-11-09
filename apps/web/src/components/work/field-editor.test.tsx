import { describe, expect, test } from "bun:test";
import type {
	WorkField,
	WorkFieldConfig,
	WorkFieldKind,
	WorkPerson,
} from "@logistack/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup as ssr } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FieldDisplay, FieldEditor } from "./field-editor";
import { commitFieldText, fieldText } from "./field-input";

const renderToStaticMarkup = (node: ReactNode) =>
	ssr(<TooltipProvider>{node}</TooltipProvider>);

const field = (config: WorkFieldConfig, name = "Field"): WorkField => ({
	id: `wfd_${config.kind}`,
	projectId: "prj_x",
	listId: null,
	name,
	kind: config.kind,
	config,
	required: false,
	description: null,
	position: "a",
});

const people: WorkPerson[] = [
	{
		userId: "usr_a",
		name: "Ada Lovelace",
		avatar: null,
		assignable: true,
		guest: false,
	},
	{
		userId: "usr_b",
		name: "Bo Diddley",
		avatar: null,
		assignable: true,
		guest: false,
	},
];

const options = [
	{ id: "o1", label: "Retail", color: "blue" as const },
	{ id: "o2", label: "Wholesale", color: "teal" as const },
];

/** One config and one stored value per kind, with the text the display must show. */
const cases: Record<WorkFieldKind, [WorkFieldConfig, unknown, string]> = {
	text: [{ kind: "text" }, "Hello", "Hello"],
	long_text: [{ kind: "long_text" }, "Line one", "Line one"],
	number: [{ kind: "number", decimals: 1, unit: "kg" }, 3.5, "3.5 kg"],
	currency: [
		{ kind: "currency", currency: "EUR", decimals: 2 },
		"1234.50",
		"1,234.50",
	],
	percent: [{ kind: "percent", decimals: 0 }, 40, "40%"],
	date: [{ kind: "date", withTime: false }, "2026-12-03", "2026"],
	checkbox: [{ kind: "checkbox" }, true, 'aria-label="Yes"'],
	select: [{ kind: "select", options }, "o2", "Wholesale"],
	multi_select: [{ kind: "multi_select", options }, ["o1", "o2"], "Retail"],
	user: [{ kind: "user", multiple: false }, "usr_a", "Ada Lovelace"],
	url: [{ kind: "url" }, "https://example.com/x", "example.com/x"],
	email: [{ kind: "email" }, "a@b.co", "mailto:a@b.co"],
	phone: [{ kind: "phone" }, "+39 02 1234", "+39 02 1234"],
	rating: [{ kind: "rating", max: 5, icon: "star" }, 3, "3 of 5"],
};

describe("FieldDisplay", () => {
	for (const [kind, [config, value, expected]] of Object.entries(cases))
		test(kind, () => {
			const html = renderToStaticMarkup(
				<FieldDisplay field={field(config)} value={value} people={people} />,
			);
			expect(html).toContain(expected);
		});

	test("empty values show a dash for every kind", () => {
		for (const [config] of Object.values(cases))
			expect(
				renderToStaticMarkup(
					<FieldDisplay field={field(config)} value={null} people={people} />,
				),
			).toContain("–");
	});

	test("unknown select options are not shown", () => {
		const html = renderToStaticMarkup(
			<FieldDisplay
				field={field(cases.select[0])}
				value="gone"
				people={people}
			/>,
		);
		expect(html).not.toContain("Retail");
		expect(html).not.toContain("gone");
	});
});

describe("FieldEditor", () => {
	const editor = (kind: WorkFieldKind, value: unknown = null) =>
		renderToStaticMarkup(
			<FieldEditor
				field={field(cases[kind][0], `My ${kind}`)}
				value={value}
				people={people}
				onCommit={() => {}}
			/>,
		);

	test("typed kinds render a labelled text box with the current value", () => {
		for (const kind of [
			"text",
			"number",
			"currency",
			"percent",
			"url",
			"email",
			"phone",
		] as const) {
			const html = editor(kind, cases[kind][1]);
			expect(html).toContain("<input");
			expect(html).toContain(`aria-label="My ${kind}"`);
			expect(html).toContain(`value="${String(cases[kind][1])}"`);
		}
		expect(editor("long_text", "x")).toContain("<textarea");
	});

	test("numeric kinds ask for a decimal keyboard", () => {
		expect(editor("number")).toContain('inputMode="decimal"');
		expect(editor("phone")).toContain('inputMode="tel"');
	});

	test("checkbox renders a labelled checkbox", () => {
		const html = editor("checkbox", true);
		expect(html).toContain('role="checkbox"');
		expect(html).toContain("My checkbox");
	});

	test("select, multi select and user render a searchable option list", () => {
		expect(editor("select", "o1")).toContain("Wholesale");
		expect(editor("multi_select", ["o1"])).toContain("Retail");
		expect(editor("user", "usr_b")).toContain("Bo Diddley");
	});

	test("rating renders one radio per step with the current one checked", () => {
		const html = editor("rating", 3);
		expect(html.match(/role="radio"/g)?.length).toBe(5);
		expect(html).toContain('aria-checked="true" aria-label="3 of 5"');
	});
});

describe("commitFieldText", () => {
	const f = (kind: WorkFieldKind) => field(cases[kind][0]);

	test("empty text clears", () => {
		expect(commitFieldText(f("number"), "  ")).toEqual({
			ok: true,
			value: null,
		});
	});

	test("numbers round to the field's decimals and respect bounds", () => {
		expect(commitFieldText(f("number"), "3.46")).toEqual({
			ok: true,
			value: 3.5,
		});
		expect(commitFieldText(f("number"), "abc").ok).toBe(false);
		expect(commitFieldText(f("percent"), "120").ok).toBe(false);
		expect(commitFieldText(f("percent"), "40%")).toEqual({
			ok: true,
			value: 40,
		});
	});

	test("currency keeps precision as a string and drops symbols", () => {
		expect(commitFieldText(f("currency"), "€ 1234,5")).toEqual({
			ok: true,
			value: "1234.50",
		});
	});

	test("dates accept ISO and plain words", () => {
		expect(commitFieldText(f("date"), "2026-12-03")).toEqual({
			ok: true,
			value: "2026-12-03",
		});
		const r = commitFieldText(f("date"), "tomorrow");
		expect(
			r.ok &&
				typeof r.value === "string" &&
				/^\d{4}-\d{2}-\d{2}$/.test(r.value),
		).toBe(true);
		expect(commitFieldText(f("date"), "someday")).toEqual({
			ok: false,
			error: "Enter a date, like “fri” or “12 dec”",
		});
	});

	test("urls get a scheme, emails and phones are checked", () => {
		expect(commitFieldText(f("url"), "example.com")).toEqual({
			ok: true,
			value: "https://example.com",
		});
		expect(commitFieldText(f("email"), "nope").ok).toBe(false);
		expect(commitFieldText(f("phone"), "+39 02 1234 5678").ok).toBe(true);
		expect(commitFieldText(f("phone"), "call me").ok).toBe(false);
	});

	test("text length limits come from the config", () => {
		const short = field({ kind: "text", maxLength: 3 });
		expect(commitFieldText(short, "abcd")).toEqual({
			ok: false,
			error: "Enter at most 3 characters",
		});
	});

	test("fieldText round-trips a stored value", () => {
		expect(fieldText(f("number"), 3.5)).toBe("3.5");
		expect(fieldText(f("text"), null)).toBe("");
	});
});
