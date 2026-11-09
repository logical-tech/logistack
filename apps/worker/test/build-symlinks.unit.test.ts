import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSymlinksInside } from "../src/build.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo(links: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "ls-symlinks-"));
	dirs.push(dir);
	writeFileSync(join(dir, "a.txt"), "a");
	for (const [name, target] of Object.entries(links))
		symlinkSync(target, join(dir, name));
	for (const argv of [
		["git", "init", "-q"],
		["git", "add", "-A"],
	])
		Bun.spawnSync(argv, { cwd: dir });
	const git = async (args: string[]) =>
		Bun.spawnSync(["git", ...args], { cwd: dir }).stdout.toString();
	return { dir, git };
}

test("links inside the checkout are fine", async () => {
	const { dir, git } = repo({ b: "a.txt", c: "./" });
	await assertSymlinksInside(dir, git);
});

test("a link out of the checkout is refused, absolute or relative, dangling or not", async () => {
	for (const target of ["/run", "../../etc", "/nonexistent/secrets"]) {
		const { dir, git } = repo({ l: target });
		await expect(assertSymlinksInside(dir, git)).rejects.toThrow(
			"points outside the repository",
		);
	}
});
