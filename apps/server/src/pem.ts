import { createPrivateKey, X509Certificate } from "node:crypto";
import { Failure } from "./errors.ts";

export type ParsedCertificate = {
	sans: string[];
	issuer: string;
	notBefore: Date;
	notAfter: Date;
};

const PEM_BLOCK =
	/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** `DNS:a.example.com, DNS:*.example.com, IP Address:1.2.3.4` → DNS names only, lowercased. */
const dnsNames = (san: string | undefined) =>
	(san ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.startsWith("DNS:"))
		.map((s) => s.slice(4).toLowerCase());

/** The `CN=` of an X.509 distinguished name, else the whole name on one line. */
export const commonName = (dn: string) =>
	/(?:^|\n)CN=([^\n]+)/.exec(dn)?.[1] ?? dn.replaceAll("\n", ", ");

/**
 * Validates an uploaded leaf certificate (optionally followed by its chain) and its private
 * key: both parse, the key matches the leaf, and the leaf names at least one DNS SAN.
 * Throws a 400 Failure with a message fit for the UI.
 */
export function parseCertificate(
	certPem: string,
	keyPem: string,
): ParsedCertificate {
	const blocks = certPem.match(PEM_BLOCK);
	if (!blocks?.[0])
		throw new Failure(
			"bad_request",
			"The certificate must be PEM, starting with -----BEGIN CERTIFICATE-----",
		);
	let leaf: X509Certificate;
	try {
		leaf = new X509Certificate(blocks[0]);
	} catch {
		throw new Failure("bad_request", "The certificate could not be parsed");
	}
	let key: ReturnType<typeof createPrivateKey>;
	try {
		key = createPrivateKey(keyPem);
	} catch {
		throw new Failure(
			"bad_request",
			"The private key could not be parsed; it must be an unencrypted PEM key",
		);
	}
	if (!leaf.checkPrivateKey(key))
		throw new Failure(
			"bad_request",
			"The private key does not belong to this certificate",
		);
	const sans = dnsNames(leaf.subjectAltName);
	if (sans.length === 0)
		throw new Failure(
			"bad_request",
			"The certificate has no DNS names (subjectAltName)",
		);
	return {
		sans,
		issuer: commonName(leaf.issuer),
		notBefore: new Date(leaf.validFrom),
		notAfter: new Date(leaf.validTo),
	};
}

/** Whether a certificate name (exact or single-label wildcard) covers `hostname`. */
export function covers(name: string, hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (name === host) return true;
	if (!name.startsWith("*.")) return false;
	const rest = host.slice(host.indexOf(".") + 1);
	return host.includes(".") && rest === name.slice(2);
}
