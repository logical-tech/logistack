import { useSyncExternalStore } from "react";

// Per browser, like the theme. Stored only when turned off, so the default is on.
const KEY = "ls-sponsor-glow-off";
const listeners = new Set<() => void>();

function read(): boolean {
	try {
		return localStorage.getItem(KEY) !== "1";
	} catch {
		return true;
	}
}

export function setSponsorGlow(on: boolean) {
	try {
		if (on) localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, "1");
	} catch {}
	for (const l of listeners) l();
}

const subscribe = (cb: () => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

export const useSponsorGlow = () => useSyncExternalStore(subscribe, read);
