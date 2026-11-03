import { expect, test } from "bun:test";
import { dockerName, newId } from "../src/ids.ts";

test("newId is prefixed, url- and docker-safe, and unique", () => {
	const ids = new Set(Array.from({ length: 10_000 }, () => newId("svc")));
	expect(ids.size).toBe(10_000);
	for (const id of ids) expect(id).toMatch(/^svc_[0-9a-hjkmnp-tv-z]{24}$/);
});

test("dockerName derives from the id body", () => {
	expect(dockerName("svc", "svc_ab12cd")).toBe("ls-svc-ab12cd");
	expect(dockerName("env", "env_zz9")).toBe("ls-env-zz9");
	const id = newId("svc");
	expect(dockerName("svc", id)).toBe(`ls-svc-${id.slice(4)}`);
});

test("dockerName rejects anything that is not an id", () => {
	for (const bad of [
		"my app",
		"svc_",
		"svc_AB",
		"svc_a;rm -rf",
		"../svc_a",
		"",
	]) {
		expect(() => dockerName("svc", bad)).toThrow();
	}
});
