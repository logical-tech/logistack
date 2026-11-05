import { describe, expect, test } from "bun:test";
import { touchesWatchPaths } from "../src/git-trigger.ts";

describe("touchesWatchPaths", () => {
	test("globs, directory prefixes, and the deploy-anyway cases", () => {
		expect(touchesWatchPaths(["apps/web/src/a.ts"], ["apps/web"])).toBe(true);
		expect(touchesWatchPaths(["apps/web-old/a.ts"], ["apps/web"])).toBe(false);
		expect(touchesWatchPaths(["apps/api/x.ts"], ["/apps/web/"])).toBe(false);
		expect(
			touchesWatchPaths(["packages/ui/b.css"], ["packages/**/*.css"]),
		).toBe(true);
		expect(touchesWatchPaths(["README.md"], [])).toBe(true);
		// Bitbucket lists no files, truncated lists are unknown: deploy.
		expect(touchesWatchPaths(undefined, ["apps/web"])).toBe(true);
	});
});
