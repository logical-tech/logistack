import { expect, test } from "bun:test";
import { parseListing } from "../src/routes/files.ts";

test("parseListing keeps files under the root, relative and sorted", () => {
	const out = [
		"11 1700000000 /usr/share/nginx/html/index.html",
		"3 1700000060 /usr/share/nginx/html/assets/a b.js",
		"5 1700000000 /etc/passwd",
		"garbage line",
		"",
	].join("\n");
	expect(parseListing(out, "/usr/share/nginx/html")).toEqual([
		{
			path: "assets/a b.js",
			size: 3,
			modifiedAt: new Date(1_700_000_060_000).toISOString(),
		},
		{
			path: "index.html",
			size: 11,
			modifiedAt: new Date(1_700_000_000_000).toISOString(),
		},
	]);
});
