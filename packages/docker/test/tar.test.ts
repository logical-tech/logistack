import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTar, safeRelativePath } from "../src/tar.ts";

test("safeRelativePath normalizes and refuses escapes", () => {
	expect(safeRelativePath("a//b/./c.html")).toBe("a/b/c.html");
	expect(safeRelativePath("./index.html")).toBe("index.html");
	for (const bad of [
		"",
		".",
		"/etc/passwd",
		"../x",
		"a/../../x",
		"a/..",
		"a\\b",
		"a\nb",
		"x".repeat(256),
	])
		expect(() => safeRelativePath(bad)).toThrow();
});

test("buildTar refuses unsafe paths and duplicates", () => {
	const data = new Uint8Array();
	expect(() => buildTar([{ path: "../x", data }])).toThrow();
	expect(() =>
		buildTar([
			{ path: "a", data },
			{ path: "./a", data },
		]),
	).toThrow();
});

test("buildTar output extracts with tar, long paths and parents included", () => {
	const long = `${"d".repeat(90)}/${"e".repeat(40)}/page.html`;
	const tar = buildTar(
		[
			{ path: "index.html", data: new TextEncoder().encode("<h1>hi</h1>") },
			{ path: "assets/app.js", data: new Uint8Array(1500).fill(97) },
			{ path: long, data: new Uint8Array([1, 2, 3]) },
		],
		1_700_000_000,
	);
	expect(tar.length % 512).toBe(0);
	const dir = mkdtempSync(join(tmpdir(), "ls-tar-"));
	try {
		const file = join(dir, "a.tar");
		writeFileSync(file, tar);
		const out = join(dir, "out");
		Bun.spawnSync(["mkdir", out]);
		const r = Bun.spawnSync(["tar", "-x", "-f", file, "-C", out]);
		expect(r.stderr.toString()).toBe("");
		expect(r.exitCode).toBe(0);
		expect(readFileSync(join(out, "index.html"), "utf8")).toBe("<h1>hi</h1>");
		expect(readFileSync(join(out, "assets/app.js")).length).toBe(1500);
		expect([...readFileSync(join(out, long))]).toEqual([1, 2, 3]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
