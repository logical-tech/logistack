import { describe, expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import {
	cloudflareOriginCa,
	originKeyAndCsr,
} from "../src/dns/cloudflare-origin-ca.ts";

/** POST /certificates as Cloudflare's API reference documents it (not captured from a live call). */
const created = {
	success: true,
	errors: [],
	messages: [],
	result: {
		id: "023e105f4ecef8ad9ca31a8372d0c353",
		certificate:
			"-----BEGIN CERTIFICATE-----\nMIIEr...\n-----END CERTIFICATE-----\n",
		csr: "-----BEGIN CERTIFICATE REQUEST-----\nMIICY...\n-----END CERTIFICATE REQUEST-----\n",
		expires_on: "2041-11-06T10:00:00Z",
		hostnames: ["app.example.com"],
		request_type: "origin-ecc",
		requested_validity: 5475,
	},
};

const hasOpenssl =
	Bun.spawnSync(["openssl", "version"], { stdout: "ignore", stderr: "ignore" })
		.exitCode === 0;

describe.each(["rsa", "ecc"] as const)("%s key and CSR", (keyType) => {
	const hosts = ["app.example.com", "www.example.com"];
	const { keyPem, csrPem } = originKeyAndCsr(hosts, keyType);

	test("the key is unencrypted PKCS#8 of the requested type", () => {
		expect(keyPem).toStartWith("-----BEGIN PRIVATE KEY-----");
		expect(createPrivateKey(keyPem).asymmetricKeyType).toBe(
			keyType === "rsa" ? "rsa" : "ec",
		);
	});

	test.skipIf(!hasOpenssl)(
		"openssl verifies the CSR signature and reads CN and SANs",
		() => {
			const p = Bun.spawnSync(
				["openssl", "req", "-noout", "-verify", "-text"],
				{ stdin: Buffer.from(csrPem), stdout: "pipe", stderr: "pipe" },
			);
			const out = p.stdout.toString() + p.stderr.toString();
			expect(p.exitCode).toBe(0);
			expect(out).toMatch(/verify OK/i);
			expect(out).toContain("CN=app.example.com");
			expect(out).toContain("DNS:app.example.com, DNS:www.example.com");
		},
	);
});

test("issue posts the CSR and returns the certificate", async () => {
	const calls: { url: string; init?: RequestInit }[] = [];
	const ca = cloudflareOriginCa("tok", {
		fetch: async (url, init) => {
			calls.push({ url, init });
			return Response.json(created);
		},
	});
	expect(
		await ca.issue({
			csrPem: "CSR",
			hostnames: ["app.example.com"],
			keyType: "ecc",
			validityDays: 5475,
		}),
	).toEqual({ id: created.result.id, certPem: created.result.certificate });
	expect(calls[0]?.url).toBe(
		"https://api.cloudflare.com/client/v4/certificates",
	);
	expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
		"Bearer tok",
	);
	expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
		csr: "CSR",
		hostnames: ["app.example.com"],
		request_type: "origin-ecc",
		requested_validity: 5475,
	});
});

test("verify lists the zone's origin certificates and surfaces a missing permission", async () => {
	const urls: string[] = [];
	const ok = cloudflareOriginCa("tok", {
		fetch: async (url) => {
			urls.push(url);
			return Response.json({ success: true, result: [] });
		},
	});
	await ok.verify("zone/1");
	expect(urls).toEqual([
		"https://api.cloudflare.com/client/v4/certificates?zone_id=zone%2F1",
	]);
	const denied = cloudflareOriginCa("tok", {
		fetch: async () =>
			Response.json(
				{
					success: false,
					errors: [{ code: 10000, message: "Authentication error" }],
				},
				{ status: 403 },
			),
	});
	await expect(denied.verify("z")).rejects.toThrow(/403/);
});
