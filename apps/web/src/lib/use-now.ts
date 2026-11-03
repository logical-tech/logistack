import { useEffect, useState } from "react";

/** Current time, re-rendered every `ms` while `active`. */
export function useNow(ms = 1000, active = true) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(t);
	}, [ms, active]);
	return now;
}
