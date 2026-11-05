import { expect, test } from "bun:test";
import { dokploySource } from "../src/migration/dokploy/source.ts";

const defaults = {
	DOKPLOY_POSTGRES_USER: "dokploy",
	DOKPLOY_POSTGRES_DB: "dokploy",
};

test("no Dokploy password: no source", () => {
	expect(dokploySource(defaults)).toBeUndefined();
});

test("the password is URL-encoded and survives a round trip", () => {
	const password = "p@ss:w/rd%?#";
	const source = dokploySource({
		...defaults,
		DOKPLOY_POSTGRES_PASSWORD: password,
	});
	expect(source?.composeRoot).toBe("/etc/dokploy/compose");
	const url = new URL(source?.url ?? "");
	expect(url.hostname).toBe("dokploy-postgres");
	expect(url.pathname).toBe("/dokploy");
	expect(decodeURIComponent(url.password)).toBe(password);
});
