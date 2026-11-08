import { expect, test } from "bun:test";
import { pickTrafficWindow } from "../src/traffic-query.ts";

test.each([
	["1h", 7, "traffic_1m", 60],
	["6h", 7, "traffic_1m", 60],
	["24h", 7, "traffic_1m", 300],
	["7d", 7, "traffic_1m", 1_800],
	["30d", 7, "traffic_1h", 7_200],
	["24h", 0, "traffic_1h", 3_600],
] as const)(
	"%s with %d minute days reads %s at %ds",
	(range, days, table, step) => {
		const w = pickTrafficWindow(range, days, Date.UTC(2026, 10, 8, 12, 7));
		expect(w.table).toBe(table);
		expect(w.step).toBe(step);
		expect(w.from.getTime() % (step * 1000)).toBe(0);
	},
);
