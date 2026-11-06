import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildTar,
	firstTarFile,
	readTar,
	safeRelativePath,
} from "../src/tar.ts";

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

test("firstTarFile reads back the first file, past directories", () => {
	const data = new TextEncoder().encode('{"acme":1}');
	const tar = buildTar([{ path: "dynamic/acme.json", data }]);
	expect(new TextDecoder().decode(firstTarFile(tar))).toBe('{"acme":1}');
	expect(firstTarFile(new Uint8Array(1024))).toBeUndefined();
});

/** `tar` in `size`-byte chunks, so headers and bodies straddle reads. */
async function* chunked(tar: Uint8Array, size: number) {
	for (let at = 0; at < tar.length; at += size)
		yield tar.subarray(at, at + size);
}

test("readTar streams headers and contents across arbitrary chunk splits", async () => {
	const tar = buildTar(
		[
			{ path: "a/b.txt", data: new TextEncoder().encode("hello world") },
			{ path: "c.bin", data: new Uint8Array(1300).fill(120) },
		],
		1_700_000_000,
	);
	const seen: { name: string; type: string; body: string }[] = [];
	for await (const e of readTar(chunked(tar, 7)))
		if ("header" in e)
			seen.push({ name: e.header.name, type: e.header.type, body: "" });
		else
			(seen.at(-1) as { body: string }).body += Buffer.from(e.data).toString();
	expect(seen).toEqual([
		{ name: "a/", type: "dir", body: "" },
		{ name: "a/b.txt", type: "file", body: "hello world" },
		{ name: "c.bin", type: "file", body: "x".repeat(1300) },
	]);
});

test("readTar applies PAX long names written by the system tar", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ls-tar-"));
	try {
		const long = `${"n".repeat(120)}.txt`;
		writeFileSync(join(dir, long), "pax!");
		// macOS tar would add an AppleDouble `._` entry without COPYFILE_DISABLE.
		const r = Bun.spawnSync(["tar", "--format", "pax", "-c", "-C", dir, long], {
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});
		expect(r.exitCode).toBe(0);
		const headers = [];
		for await (const e of readTar(chunked(new Uint8Array(r.stdout), 100)))
			if ("header" in e) headers.push(e.header);
		expect(headers.map((h) => [h.name, h.type, h.size])).toEqual([
			[long, "file", 4],
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readTar refuses a truncated archive", async () => {
	const tar = buildTar([{ path: "f", data: new Uint8Array(2000) }]);
	const run = async () => {
		for await (const _ of readTar(chunked(tar.subarray(0, 900), 64))) {
		}
	};
	await expect(run()).rejects.toThrow("tar ended mid-entry");
});
