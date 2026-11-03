import { describe, expect, test } from "bun:test";
import { databaseEngines } from "@logistack/contracts";
import { dumpScript, restoreScript } from "../src/db-scripts.ts";

describe("database dump scripts", () => {
	test("credentials reach the tools through env or a 0600 file, never a flag", () => {
		for (const engine of databaseEngines) {
			const s = dumpScript(engine);
			expect(s).not.toMatch(/--password[= ]|-p\$|-p"\$/);
			if (engine === "mysql" || engine === "mariadb" || engine === "mongo")
				expect(s).toContain("umask 077");
		}
	});

	test("redis and libsql restores go through the volume", () => {
		expect(() => restoreScript("redis")).toThrow(/volume/);
		expect(() => restoreScript("libsql")).toThrow(/volume/);
	});
});
