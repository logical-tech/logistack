import { ensureContrast, format, parse } from "./color";
import { EDITOR_THEMES } from "./editor";
import { SHADCN_PRESETS } from "./shadcn-presets";
import {
	DEFAULT_THEME,
	type Mode,
	type ThemeSource,
	type Tokens,
} from "./types";

export type { Mode, ThemeSource, Tokens };
export { DEFAULT_THEME };

/** Every selectable theme after LogiStack Default, in picker order. */
export const THEMES: ThemeSource[] = [...EDITOR_THEMES, ...SHADCN_PRESETS];

export const THEME_GROUPS = [...new Set(THEMES.map((t) => t.group))];

export const themeLabel = (id: string) =>
	id === DEFAULT_THEME
		? "LogiStack Default"
		: (THEMES.find((t) => t.id === id)?.label ?? id);

/** LogiStack's own status text colours (index.css), the starting point for themes that keep its status hues. */
const STATUS_TEXT: Record<Mode, Tokens> = {
	light: {
		"ok-text": "oklch(0.47 0.12 152)",
		"busy-text": "oklch(0.5 0.11 65)",
		"info-text": "oklch(0.48 0.17 258)",
		"warn-text": "oklch(0.52 0.15 45)",
		"bad-text": "oklch(0.5 0.19 25)",
		"idle-text": "oklch(0.49 0.012 262)",
	},
	dark: {
		"ok-text": "oklch(0.78 0.14 152)",
		"busy-text": "oklch(0.83 0.13 80)",
		"info-text": "oklch(0.76 0.13 258)",
		"warn-text": "oklch(0.79 0.14 55)",
		"bad-text": "oklch(0.74 0.16 25)",
		"idle-text": "oklch(0.71 0.01 262)",
	},
};

/** Text tokens and the surfaces each must read on at 4.5:1. */
export const TEXT_ON: [string, string[]][] = [
	["foreground", ["background", "card"]],
	["card-foreground", ["card"]],
	["popover-foreground", ["popover"]],
	["muted-foreground", ["background", "card"]],
	["primary-foreground", ["primary"]],
	["sidebar-foreground", ["sidebar"]],
	...Object.keys(STATUS_TEXT.light).map((k): [string, string[]] => [
		k,
		["background", "card"],
	]),
];

/**
 * A theme variant as the custom properties to set on <html>. The accent doubles as
 * LogiStack's brand colour, and every text token is nudged until it reaches 4.5:1
 * on its surfaces: imported palettes were tuned for marketing pages, not for a
 * dashboard full of 13 px status text.
 */
export function resolveVariant(src: ThemeSource, mode: Mode): Tokens {
	const t: Tokens = {
		brand: src[mode].primary as string,
		"brand-foreground": src[mode]["primary-foreground"] as string,
		...STATUS_TEXT[mode],
		...src[mode],
		...(src.radius && { radius: src.radius }),
	};
	for (const [key, surfaces] of TEXT_ON) {
		const fg = parse(t[key] ?? "");
		const bgs = surfaces.flatMap((s) => parse(t[s] ?? "") ?? []);
		if (!fg || bgs.length === 0) continue;
		const fixed = ensureContrast(fg, bgs, 4.5);
		if (fixed && fixed !== fg) t[key] = format(fixed);
	}
	return t;
}

export function resolveTheme(id: string) {
	const src = THEMES.find((t) => t.id === id);
	if (!src) return null;
	return {
		light: resolveVariant(src, "light"),
		dark: resolveVariant(src, "dark"),
	};
}
