import { useSyncExternalStore } from "react";
import { DEFAULT_THEME, type Tokens } from "./themes/types";

export type ThemePreference = "light" | "dark" | "system";
/** Both variants of the chosen theme as custom properties, so a mode switch needs no lookup. */
export type ThemeVars = { light: Tokens; dark: Tokens };

// index.html reads the same three keys before first paint.
const KEY = "ls-theme";
const NAME_KEY = "ls-theme-name";
const VARS_KEY = "ls-theme-vars";

const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

function read(): ThemePreference {
	try {
		const v = localStorage.getItem(KEY);
		return v === "light" || v === "dark" ? v : "system";
	} catch {
		return "system";
	}
}

function readName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

function readVars(): ThemeVars | null {
	try {
		const raw = localStorage.getItem(VARS_KEY);
		return raw ? (JSON.parse(raw) as ThemeVars) : null;
	} catch {
		return null;
	}
}

export const resolvedTheme = (pref = read()): "light" | "dark" =>
	pref === "system" ? (media.matches ? "dark" : "light") : pref;

const cached = readVars();
/** Properties currently set inline on <html>, starting with whatever index.html set. */
let applied = cached
	? [...new Set([...Object.keys(cached.light), ...Object.keys(cached.dark)])]
	: [];

function apply() {
	const root = document.documentElement;
	const dark = resolvedTheme() === "dark";
	// Suppress colour transitions for the frame the theme flips in.
	root.classList.add("[&_*]:transition-none!");
	root.classList.toggle("dark", dark);
	const name = readName();
	const vars = name === DEFAULT_THEME ? null : readVars();
	const map = vars?.[dark ? "dark" : "light"] ?? {};
	for (const k of applied) if (!(k in map)) root.style.removeProperty(`--${k}`);
	for (const [k, v] of Object.entries(map)) root.style.setProperty(`--${k}`, v);
	applied = Object.keys(map);
	if (vars) root.dataset.theme = name;
	else delete root.dataset.theme;
	requestAnimationFrame(() => root.classList.remove("[&_*]:transition-none!"));
	for (const l of listeners) l();
}

media.addEventListener("change", apply);

export function setTheme(pref: ThemePreference) {
	try {
		if (pref === "system") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, pref);
	} catch {}
	apply();
}

/** `vars` null (or the default id) returns to LogiStack Default. */
export function setThemeName(name: string, vars: ThemeVars | null) {
	try {
		if (name === DEFAULT_THEME || !vars) {
			localStorage.removeItem(NAME_KEY);
			localStorage.removeItem(VARS_KEY);
		} else {
			localStorage.setItem(NAME_KEY, name);
			localStorage.setItem(VARS_KEY, JSON.stringify(vars));
		}
	} catch {}
	apply();
}

// The cached variables were resolved by an earlier release; refresh them from the
// current theme list (and fall back to the default if the theme is gone).
if (readName() !== DEFAULT_THEME)
	void import("./themes").then(({ resolveTheme }) => {
		const name = readName();
		setThemeName(name, resolveTheme(name));
	});

const subscribe = (cb: () => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

export function useTheme() {
	const preference = useSyncExternalStore(subscribe, read);
	const resolved = useSyncExternalStore(subscribe, () => resolvedTheme());
	const name = useSyncExternalStore(subscribe, readName);
	return { preference, resolved, name, setTheme, setThemeName };
}
