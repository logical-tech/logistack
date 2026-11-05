import { describe, expect, test } from "bun:test";
import { contrast, ensureContrast, parse, worstContrast } from "./color";
import { resolveTheme, TEXT_ON, THEMES } from "./index";

const REQUIRED = [
	"background",
	"foreground",
	"card",
	"card-foreground",
	"popover",
	"popover-foreground",
	"primary",
	"primary-foreground",
	"secondary",
	"secondary-foreground",
	"muted",
	"muted-foreground",
	"accent",
	"accent-foreground",
	"destructive",
	"border",
	"input",
	"ring",
	"sidebar",
	"sidebar-foreground",
	"sidebar-accent",
	"sidebar-accent-foreground",
	"sidebar-border",
];

describe("colour math", () => {
	test("black on white is 21:1", () => {
		const black = parse("#000") as NonNullable<ReturnType<typeof parse>>;
		const white = parse("oklch(1 0 0)") as NonNullable<
			ReturnType<typeof parse>
		>;
		expect(contrast(black, white)).toBeCloseTo(21, 0);
	});

	test("translucent colours are not judged", () => {
		expect(parse("oklch(1 0 0 / 10%)")).toBeNull();
		expect(parse("#58a6ff40")).toBeNull();
	});

	test("ensureContrast darkens a pale yellow until it reads on white", () => {
		const yellow = parse("#f9e2af") as NonNullable<ReturnType<typeof parse>>;
		const white = parse("#ffffff") as NonNullable<ReturnType<typeof parse>>;
		const fixed = ensureContrast(yellow, [white], 4.5);
		expect(fixed).not.toBeNull();
		expect(fixed?.l).toBeLessThan(yellow.l);
		expect(
			worstContrast(fixed as typeof yellow, [white]),
		).toBeGreaterThanOrEqual(4.5);
	});
});

describe("themes", () => {
	test("ids are unique", () => {
		const ids = THEMES.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	for (const theme of THEMES)
		test(`${theme.label} (${theme.id}) is complete and readable`, () => {
			for (const mode of ["light", "dark"] as const)
				for (const key of REQUIRED)
					expect(theme[mode][key], `${mode} --${key}`).toBeString();

			const resolved = resolveTheme(theme.id);
			expect(resolved).not.toBeNull();
			for (const mode of ["light", "dark"] as const) {
				const t = resolved?.[mode] ?? {};
				for (const [key, surfaces] of TEXT_ON) {
					const fg = parse(t[key] ?? "");
					const bgs = surfaces.flatMap((s) => parse(t[s] ?? "") ?? []);
					if (!fg || bgs.length === 0) continue;
					expect(
						worstContrast(fg, bgs),
						`${mode} --${key} on ${surfaces.join(", ")}`,
					).toBeGreaterThanOrEqual(4.5);
				}
			}
		});
});
