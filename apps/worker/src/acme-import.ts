import { createPrivateKey, X509Certificate } from "node:crypto";
import type { RedisClient } from "bun";
import { z } from "zod";
import { CADDY_PREFIX, covers } from "./certs.ts";

/** Where Dokploy's Traefik keeps its ACME state, on a Dokploy server. */
export const DOKPLOY_ACME_PATH = "/etc/dokploy/traefik/dynamic/acme.json";
/** certmagic's issuer key for Let's Encrypt, the first issuer compileProxy configures. */
export const LETSENCRYPT_ISSUER_KEY = "acme-v02.api.letsencrypt.org-directory";

// Traefik's ACME storage: resolver name -> account and certificates, PEMs base64-encoded.
const acmeJson = z.record(
	z.string(),
	z.object({
		Certificates: z
			.array(
				z.object({
					domain: z.object({ main: z.string() }),
					certificate: z.string(),
					key: z.string(),
				}),
			)
			.nullish(),
	}),
);

/** One file in Caddy's storage, keyed relative to the storage prefix. */
export type CaddyFile = { key: string; value: string };
export type AcmeImport = {
	hostname: string;
	/** Hex, as `X509Certificate.serialNumber` and a TLS client report it. */
	serial: string;
	notAfter: string;
	/** `.key`, `.json`, then `.crt`: a reader that finds the `.crt` finds the rest. */
	files: CaddyFile[];
};
export type AcmeImportPlan = {
	imports: AcmeImport[];
	skipped: { hostname: string; reason: string }[];
};

type Parsed = {
	names: string[];
	serial: string;
	notBefore: number;
	notAfter: number;
	certPem: string;
	keyPem: string;
};

/** certmagic's `StorageKeys.Safe` for one key component. */
const safe = (s: string) =>
	s
		.toLowerCase()
		.trim()
		.replaceAll(" ", "_")
		.replaceAll("+", "_plus_")
		.replaceAll("*", "wildcard_")
		.replaceAll(":", "-")
		.replaceAll("..", "")
		.replace(/[^\w@.-]/g, "");

const fromBase64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

/** A certificate whose key matches it, else undefined: a broken pair would fail every handshake. */
function parse(certPem: string, keyPem: string): Parsed | undefined {
	try {
		const x = new X509Certificate(certPem);
		if (!x.checkPrivateKey(createPrivateKey(keyPem))) return undefined;
		return {
			names: (x.subjectAltName ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.startsWith("DNS:"))
				.map((s) => s.slice(4).toLowerCase()),
			serial: x.serialNumber.toLowerCase(),
			notBefore: Date.parse(x.validFrom),
			notAfter: Date.parse(x.validTo),
			certPem,
			keyPem,
		};
	} catch {
		return undefined;
	}
}

/**
 * Which of Traefik's certificates Caddy can take over for `hostnames` (the migrated domains),
 * and the storage files that make Caddy serve and later renew them. A hostname imports only
 * a certificate valid at `now` whose one name is that hostname: certmagic renews a managed
 * certificate by its first name, so a wildcard or multi-name certificate would renew the
 * wrong subject. Those hostnames are skipped and Caddy issues them a fresh certificate.
 * Of several matches, the one that expires last wins.
 */
export function planAcmeImport(
	raw: string,
	hostnames: string[],
	now: Date,
): AcmeImportPlan {
	const certs = Object.values(acmeJson.parse(JSON.parse(raw))).flatMap((r) =>
		(r.Certificates ?? []).flatMap(
			(c) => parse(fromBase64(c.certificate), fromBase64(c.key)) ?? [],
		),
	);
	const plan: AcmeImportPlan = { imports: [], skipped: [] };
	for (const hostname of [...new Set(hostnames.map((h) => h.toLowerCase()))]) {
		const covering = certs.filter((c) =>
			c.names.some((n) => covers(n, hostname)),
		);
		const own = covering.filter(
			(c) => c.names.length === 1 && c.names[0] === hostname,
		);
		const best = own
			.filter((c) => c.notBefore <= now.getTime() && now.getTime() < c.notAfter)
			.sort((a, b) => b.notAfter - a.notAfter)[0];
		if (!best) {
			plan.skipped.push({
				hostname,
				reason:
					covering.length === 0
						? "no certificate in acme.json"
						: own.length === 0
							? "only in a wildcard or multi-name certificate"
							: "expired or not yet valid",
			});
			continue;
		}
		const base = `certificates/${LETSENCRYPT_ISSUER_KEY}/${safe(hostname)}/${safe(hostname)}`;
		plan.imports.push({
			hostname,
			serial: best.serial,
			notAfter: new Date(best.notAfter).toISOString(),
			files: [
				{ key: `${base}.key`, value: best.keyPem },
				{ key: `${base}.json`, value: JSON.stringify({ sans: [hostname] }) },
				{ key: `${base}.crt`, value: best.certPem },
			],
		});
	}
	return plan;
}

/**
 * Writes `plan` into Caddy's Redis storage the way pberkel/caddy-storage-redis stores a file:
 * a JSON envelope at `<prefix>/<key>`, plus each parent directory in its sorted-set index.
 * A hostname Caddy already has a certificate for is left alone, so a re-run never replaces
 * a certificate Caddy issued itself. Returns the hostnames written.
 */
export async function storeInCaddy(
	redis: RedisClient,
	plan: AcmeImportPlan,
	now = new Date(),
	prefix = CADDY_PREFIX,
): Promise<string[]> {
	const written: string[] = [];
	for (const imp of plan.imports) {
		const crt = imp.files.at(-1);
		if (!crt || (await redis.exists(`${prefix}/${crt.key}`))) continue;
		for (const f of imp.files) {
			const key = `${prefix}/${f.key}`;
			const bytes = Buffer.from(f.value);
			const score = String(Math.floor(now.getTime() / 1000));
			const parts = key.split("/");
			for (let i = parts.length - 1; i > 0; i--)
				await redis.send("ZADD", [
					parts.slice(0, i).join("/"),
					score,
					i === parts.length - 1 ? (parts[i] as string) : `${parts[i]}/`,
				]);
			await redis.set(
				key,
				JSON.stringify({
					value: bytes.toString("base64"),
					modified: now.toISOString(),
					size: bytes.length,
					compression: 0,
					encryption: 0,
				}),
			);
		}
		written.push(imp.hostname);
	}
	return written;
}
