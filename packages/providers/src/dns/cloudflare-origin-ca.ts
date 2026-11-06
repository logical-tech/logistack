import { generateKeyPairSync, sign } from "node:crypto";
import { type Deps, Http } from "../http.ts";

const API = "https://api.cloudflare.com/client/v4";

export type OriginKeyType = "rsa" | "ecc";
/** The only validity periods Cloudflare's Origin CA accepts, in days. */
export const originValidityDays = [7, 30, 90, 365, 730, 1095, 5475] as const;
export type OriginValidityDays = (typeof originValidityDays)[number];

/** The token permission Origin CA calls need. */
export const originCaPermission = "Zone > SSL and Certificates > Edit";

// Minimal DER writer: just the tags a PKCS#10 request needs.
const len = (n: number) => {
	if (n < 0x80) return Buffer.from([n]);
	const b: number[] = [];
	for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff);
	return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag: number, ...parts: Uint8Array[]) => {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Uint8Array[]) => tlv(0x30, ...p);
const oid = (dotted: string) => {
	const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
	const out = [40 * a + b];
	for (const v of rest) {
		const bytes = [v & 0x7f];
		for (let x = v >> 7; x > 0; x >>= 7) bytes.unshift((x & 0x7f) | 0x80);
		out.push(...bytes);
	}
	return tlv(0x06, Buffer.from(out));
};

const SIGNATURE = {
	rsa: seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00])),
	ecc: seq(oid("1.2.840.10045.4.3.2")),
};

/**
 * A fresh private key (RSA 2048 or ECDSA P-256) and a PKCS#10 request for it: CN is the first
 * hostname, every hostname is a DNS SAN, signed SHA-256. The key stays with the caller.
 */
export function originKeyAndCsr(
	hostnames: string[],
	keyType: OriginKeyType,
): { keyPem: string; csrPem: string } {
	const { privateKey, publicKey } =
		keyType === "rsa"
			? generateKeyPairSync("rsa", { modulusLength: 2048 })
			: generateKeyPairSync("ec", { namedCurve: "P-256" });
	const cn = seq(
		tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(hostnames[0] ?? "")))),
	);
	const sans = seq(...hostnames.map((h) => tlv(0x82, Buffer.from(h))));
	const extensionRequest = seq(
		oid("1.2.840.113549.1.9.14"),
		tlv(0x31, seq(seq(oid("2.5.29.17"), tlv(0x04, sans)))),
	);
	const info = seq(
		Buffer.from([0x02, 0x01, 0x00]),
		cn,
		publicKey.export({ type: "spki", format: "der" }),
		tlv(0xa0, extensionRequest),
	);
	const csr = seq(
		info,
		SIGNATURE[keyType],
		tlv(0x03, Buffer.from([0]), sign("sha256", info, privateKey)),
	);
	const b64 = csr
		.toString("base64")
		.match(/.{1,64}/g)
		?.join("\n");
	return {
		keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		csrPem: `-----BEGIN CERTIFICATE REQUEST-----\n${b64}\n-----END CERTIFICATE REQUEST-----\n`,
	};
}

/** Cloudflare Origin CA over an API token with Zone > SSL and Certificates > Edit. */
export function cloudflareOriginCa(apiToken: string, deps?: Deps) {
	const http = new Http("cloudflare", deps);
	const headers = {
		authorization: `Bearer ${apiToken}`,
		"content-type": "application/json",
	};
	return {
		/** Lists the zone's origin certificates: proves the token reaches Origin CA for this zone. */
		async verify(zoneId: string) {
			await http.json(
				"listOriginCertificates",
				`${API}/certificates?zone_id=${encodeURIComponent(zoneId)}`,
				{ headers },
			);
		},
		async issue(input: {
			csrPem: string;
			hostnames: string[];
			keyType: OriginKeyType;
			validityDays: OriginValidityDays;
		}) {
			const { result } = await http.json<{
				result: { id: string; certificate: string; expires_on: string };
			}>("createOriginCertificate", `${API}/certificates`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					csr: input.csrPem,
					hostnames: input.hostnames,
					request_type: `origin-${input.keyType}`,
					requested_validity: input.validityDays,
				}),
			});
			return { id: result.id, certPem: result.certificate };
		},
	};
}
