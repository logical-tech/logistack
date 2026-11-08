import { describe, expect, test } from "bun:test";
import {
	formatSecretReference,
	parseSecretReference,
	SecretInput,
	secretReferenceIssue,
	secretReferenceTail,
} from "../src/index.ts";

const ok = (v: string) => {
	const r = parseSecretReference(v);
	if (!r.ok) throw new Error(r.error);
	return r.ref;
};
const err = (v: string) => {
	const r = parseSecretReference(v);
	if (r.ok) throw new Error(`parsed ${v}`);
	return r.error;
};

describe("parseSecretReference", () => {
	test("splits provider, path and key", () => {
		expect(ok("secret://vault-prod/kv/app/db#password")).toEqual({
			provider: "vault-prod",
			path: ["kv", "app", "db"],
			key: "password",
		});
	});

	test("decodes percent-encoded segments and keys", () => {
		expect(ok("secret://op/Prod%20Vault/My%2FItem#API%20key")).toEqual({
			provider: "op",
			path: ["Prod Vault", "My/Item"],
			key: "API key",
		});
	});

	test("round-trips through the canonical form", () => {
		const ref = { provider: "op", path: ["Prod Vault", "a#b"], key: "x y" };
		expect(ok(formatSecretReference(ref))).toEqual(ref);
		expect(secretReferenceTail(ref)).toBe("Prod%20Vault/a%23b#x%20y");
	});

	test.each([
		["vault://x/a#b", "starts with secret://"],
		["secret://x/a/b", "#<key>"],
		["secret://x/a#", "key"],
		["secret://Bad_Name/a#b", "provider's name"],
		["secret:///a#b", "provider's name"],
		["secret://x#b", "empty segment"],
		["secret://x/a//b#c", "empty segment"],
		["secret://x/a/../b#c", "invalid segment"],
		["secret://x/%E0%A4%A#c", "invalid segment"],
		[`secret://x/${"a".repeat(1100)}#c`, "1024"],
	])("rejects %s", (value, message) => {
		expect(err(value)).toContain(message);
	});
});

describe("secretReferenceIssue", () => {
	test("checks the path shape per provider kind", () => {
		const one = ok("secret://p/prod#NAME");
		const two = ok("secret://p/a/b#f");
		const three = ok("secret://p/a/b/c#f");
		expect(secretReferenceIssue("vault", one)).toContain("<mount>");
		expect(secretReferenceIssue("vault", three)).toBeNull();
		expect(secretReferenceIssue("infisical", one)).toBeNull();
		expect(secretReferenceIssue("onepassword", two)).toBeNull();
		expect(secretReferenceIssue("onepassword", three)).toContain("<item>");
	});
});

describe("SecretInput", () => {
	const base = { scope: "organization", scopeId: "org_1", key: "DB_PASSWORD" };
	test("takes a value or a reference, not both", () => {
		expect(SecretInput.safeParse({ ...base, value: "x" }).success).toBe(true);
		expect(
			SecretInput.safeParse({ ...base, reference: "secret://v/kv/a#b" })
				.success,
		).toBe(true);
		expect(SecretInput.safeParse(base).success).toBe(false);
		expect(
			SecretInput.safeParse({
				...base,
				value: "x",
				reference: "secret://v/kv/a#b",
			}).success,
		).toBe(false);
		expect(
			SecretInput.safeParse({ ...base, reference: "secret://v/kv/a" }).success,
		).toBe(false);
	});
});
