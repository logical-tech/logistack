import { expect, test } from "bun:test";
import { Hostname } from "../src/index.ts";

test.each([
	"app.example.com",
	"*.example.com",
	"*.preview.example.com",
	"*.EXAMPLE.com",
])("accepts %s", (h) => {
	expect(Hostname.safeParse(h).success).toBe(true);
});

test.each([
	["*.*.example.com", "two wildcard labels"],
	["a.*.example.com", "a wildcard below the first label"],
	["*example.com", "a partial-label wildcard"],
	["*.com", "a wildcard over a bare TLD"],
	["*", "a bare star"],
	["https://app.example.com", "a URL"],
])("refuses %s (%s)", (h) => {
	expect(Hostname.safeParse(h).success).toBe(false);
});
