import { expect, test } from "bun:test";
import { shellPolicy } from "../src/app.ts";

test("the shell's CSP lets forms post only here and to GitHub (the App manifest flow)", () => {
	const policy = shellPolicy("<!doctype html><script>1</script>");
	expect(policy.split("; ")).toContain("form-action 'self' https://github.com");
	expect(policy).toMatch(/script-src 'self' 'sha256-[^']+'/);
});
