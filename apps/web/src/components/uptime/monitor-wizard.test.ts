import { expect, test } from "bun:test";
import { monitors } from "@/lib/api/mock/uptime";
import { emptyMonitor, toConfig, toInput, valuesOf } from "./monitor-wizard";

test("an existing monitor's config survives the edit wizard unchanged", () => {
	for (const m of monitors) expect(toConfig(valuesOf(m))).toEqual(m.config);
});

test("text answers become the API body", () => {
	const input = toInput({
		...emptyMonitor,
		kind: "http",
		name: " Shop ",
		url: "https://shop.example.com/health",
		statusCodes: "200, 301-302",
		headers: "Authorization: Bearer x:y\n\n",
		keyword: "ok",
		maxLatencyMs: "800",
	});
	expect(input.name).toBe("Shop");
	expect(input.config).toEqual({
		kind: "http",
		http: {
			url: "https://shop.example.com/health",
			method: "GET",
			headers: [{ name: "Authorization", value: "Bearer x:y" }],
			statusCodes: ["200", "301-302"],
			followRedirects: true,
			keyword: { value: "ok", invert: false, caseSensitive: false },
			maxLatencyMs: 800,
		},
	});
	expect(input.domainId).toBeUndefined();
});
