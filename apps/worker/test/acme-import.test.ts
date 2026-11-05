import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { LETSENCRYPT_ISSUER_KEY, planAcmeImport } from "../src/acme-import.ts";

// Self-signed RSA certificates generated with openssl on 2026-11-05: the app.example.test
// and old.example.test "short" ones are valid one day, the others ten years. bad.example.test
// carries another certificate's key.
const raw = await Bun.file(`${import.meta.dir}/fixtures/acme.json`).text();
const later = new Date("2027-06-01T00:00:00Z");

describe("planAcmeImport", () => {
	const plan = planAcmeImport(
		raw,
		[
			"App.Example.Test",
			"app.example.test",
			"old.example.test",
			"a.example.test",
			"x.wild.example.test",
			"bad.example.test",
			"missing.example.test",
		],
		later,
	);

	test("imports only the migrated hostnames, the certificate that expires last", () => {
		expect(plan.imports.map((i) => i.hostname)).toEqual(["app.example.test"]);
		const [app] = plan.imports;
		const crt = app?.files.find((f) => f.key.endsWith(".crt"))?.value ?? "";
		const x = new X509Certificate(crt);
		expect(app?.serial).toBe(x.serialNumber.toLowerCase());
		expect(Date.parse(x.validTo)).toBeGreaterThan(Date.parse("2035-01-01"));
		expect(app?.notAfter).toBe(new Date(x.validTo).toISOString());
	});

	test("writes the key, the metadata and the certificate where certmagic loads them", () => {
		const base = `certificates/${LETSENCRYPT_ISSUER_KEY}/app.example.test/app.example.test`;
		const files = plan.imports[0]?.files ?? [];
		expect(files.map((f) => f.key)).toEqual([
			`${base}.key`,
			`${base}.json`,
			`${base}.crt`,
		]);
		expect(files[0]?.value).toStartWith("-----BEGIN PRIVATE KEY-----");
		expect(JSON.parse(files[1]?.value ?? "")).toEqual({
			sans: ["app.example.test"],
		});
		expect(files[2]?.value).toStartWith("-----BEGIN CERTIFICATE-----");
	});

	test("says why every other hostname is skipped", () => {
		expect(plan.skipped).toEqual([
			{ hostname: "old.example.test", reason: "expired or not yet valid" },
			{
				hostname: "a.example.test",
				reason: "only in a wildcard or multi-name certificate",
			},
			{
				hostname: "x.wild.example.test",
				reason: "only in a wildcard or multi-name certificate",
			},
			{ hostname: "bad.example.test", reason: "no certificate in acme.json" },
			{
				hostname: "missing.example.test",
				reason: "no certificate in acme.json",
			},
		]);
	});

	test("a certificate not yet valid is not imported", () => {
		const before = planAcmeImport(
			raw,
			["app.example.test"],
			new Date("2020-01-01T00:00:00Z"),
		);
		expect(before.imports).toEqual([]);
		expect(before.skipped[0]?.reason).toBe("expired or not yet valid");
	});

	test("no hostnames, no imports; a malformed acme.json throws", () => {
		expect(planAcmeImport(raw, [], later)).toEqual({
			imports: [],
			skipped: [],
		});
		expect(() =>
			planAcmeImport('{"le":{"Certificates":[{}]}}', [], later),
		).toThrow();
	});
});
