import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
const KEY = "ls-theme";
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

export const resolvedTheme = (pref = read()): "light" | "dark" =>
	pref === "system" ? (media.matches ? "dark" : "light") : pref;

function apply() {
	const root = document.documentElement;
	// Suppress colour transitions for the frame the theme flips in.
	root.classList.add("[&_*]:transition-none!");
	root.classList.toggle("dark", resolvedTheme() === "dark");
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

const subscribe = (cb: () => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

export function useTheme() {
	const preference = useSyncExternalStore(subscribe, read);
	const resolved = useSyncExternalStore(subscribe, () => resolvedTheme());
	return { preference, resolved, setTheme };
}
