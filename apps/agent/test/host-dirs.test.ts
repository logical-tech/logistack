import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ArchiveRefused,
	listHostDirs,
	resolveHostPath,
} from "../src/archive.ts";

/** A fake host `/`: /srv/app, /srv/file, /data -> /srv (absolute), /srv/up -> ../.. (escapes). */
function host() {
	const root = mkdtempSync(join(tmpdir(), "ls-host-dirs-"));
	mkdirSync(join(root, "srv/app"), { recursive: true });
	writeFileSync(join(root, "srv/file"), "x");
	symlinkSync("/srv", join(root, "data"));
	symlinkSync("../..", join(root, "srv/up"));
	symlinkSync("/nowhere", join(root, "srv/dangling"));
	return root;
}

describe("host dirs", () => {
	test("absolute symlinks resolve inside the host root", async () => {
		const root = host();
		expect(await resolveHostPath(root, "/data/app")).toBe("/srv/app");
	});

	test("links and .. never climb above the host root", async () => {
		const root = host();
		expect(await resolveHostPath(root, "/srv/up")).toBe("/");
		expect(await resolveHostPath(root, "/srv/up/srv/app")).toBe("/srv/app");
		expect(await resolveHostPath(root, "/../../srv")).toBe("/srv");
	});

	test("lists only directories and links to them", async () => {
		const root = host();
		const r = await listHostDirs(root, "/data");
		expect(r.path).toBe("/srv");
		expect(r.entries?.map((e) => [e.name, e.type])).toEqual([
			["app", "dir"],
			["up", "symlink"],
		]);
	});

	test("a missing path or a file is refused", async () => {
		const root = host();
		expect(listHostDirs(root, "/missing")).rejects.toBeInstanceOf(
			ArchiveRefused,
		);
		expect(listHostDirs(root, "/srv/file")).rejects.toBeInstanceOf(
			ArchiveRefused,
		);
	});
});
