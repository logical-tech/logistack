import { useEffect, useState } from "react";

/** Seconds since `startedAt`, re-rendering once a second while it is set. */
export function useElapsed(startedAt: string | null | undefined): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!startedAt) return;
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [startedAt]);
	return startedAt
		? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
		: 0;
}

/** `1:05:09`, `5:09`. */
export function clock(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	const mm = String(m).padStart(h ? 2 : 1, "0");
	return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** Local `YYYY-MM-DD` of an instant (the grid and report work in the viewer's zone). */
export const localDay = (d: Date | string) => {
	const x = typeof d === "string" ? new Date(d) : d;
	return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

/** 09:00 local on `day`, as an ISO instant with offset. */
export const morningOf = (day: string) =>
	new Date(`${day}T09:00:00`).toISOString();
