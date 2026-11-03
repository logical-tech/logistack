import { X509Certificate } from "node:crypto";
import type { EventEnvelope } from "@logistack/contracts";
import {
	certificate,
	domain,
	environment,
	project,
	service,
} from "@logistack/db";
import type { RedisClient } from "bun";
import { eq } from "drizzle-orm";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";

/** Same key as apps/server/src/redis.ts; the server reads the snapshot from it. */
export const CERTS_KEY = "ls:certs";
/** Caddy's storage key prefix (compileProxy `storage.keyPrefix`). */
export const CADDY_PREFIX = "caddy";
/** Days before expiry at which `certificate.expiring` fires, once each. */
export const EXPIRY_THRESHOLDS = [14, 7, 3] as const;

export type ManagedCert = {
	names: string[];
	issuer: string;
	notBefore: string;
	notAfter: string;
};
export type CertSnapshot = { at: string; certs: ManagedCert[] };

const DAY = 86_400_000;

/** `CN=` of a distinguished name, else the whole name on one line. */
const commonName = (dn: string) =>
	/(?:^|\n)CN=([^\n]+)/.exec(dn)?.[1] ?? dn.replaceAll("\n", ", ");

/** DNS names of a PEM certificate, from subjectAltName. */
export function describePem(pem: string): ManagedCert {
	const x = new X509Certificate(pem);
	return {
		names: (x.subjectAltName ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.startsWith("DNS:"))
			.map((s) => s.slice(4).toLowerCase()),
		issuer: commonName(x.issuer),
		notBefore: new Date(x.validFrom).toISOString(),
		notAfter: new Date(x.validTo).toISOString(),
	};
}

/**
 * Every certificate in Caddy's shared Redis storage (pberkel/caddy-storage-redis): keys
 * `<prefix>/certificates/<issuer>/<name>/<name>.crt`, values `{"value": <base64 PEM>, ...}`.
 */
export async function readCaddyCerts(
	redis: RedisClient,
	prefix = CADDY_PREFIX,
): Promise<ManagedCert[]> {
	const keys: string[] = [];
	let cursor = "0";
	// shortcut: SCAN over the keyspace; switch to the module's sorted-set index past ~100k keys.
	do {
		const [next, batch] = (await redis.send("SCAN", [
			cursor,
			"MATCH",
			`${prefix}/certificates/*.crt`,
			"COUNT",
			"1000",
		])) as [string, string[]];
		cursor = next;
		keys.push(...batch);
	} while (cursor !== "0");
	const certs: ManagedCert[] = [];
	for (const key of keys.sort()) {
		const raw = await redis.get(key);
		try {
			const { value } = JSON.parse(raw ?? "") as { value: string };
			certs.push(
				describePem(new TextDecoder().decode(Uint8Array.fromBase64(value))),
			);
		} catch {
			log("warn", "unreadable certificate in caddy storage", { key });
		}
	}
	return certs;
}

export async function refreshCertSnapshot(ctx: Ctx): Promise<ManagedCert[]> {
	const certs = await readCaddyCerts(ctx.bus.redis);
	const snapshot: CertSnapshot = { at: new Date().toISOString(), certs };
	await ctx.bus.redis.set(CERTS_KEY, JSON.stringify(snapshot));
	return certs;
}

export const covers = (name: string, hostname: string) =>
	name === hostname ||
	(name.startsWith("*.") &&
		hostname.includes(".") &&
		hostname.slice(hostname.indexOf(".") + 1) === name.slice(2));

export type CertSubject =
	| { source: "managed"; cert: ManagedCert }
	| {
			source: "custom";
			cert: ManagedCert;
			id: string;
			name: string;
			organizationId: string;
	  };

export type DomainRef = {
	id: string;
	hostname: string;
	tls: "auto" | "custom" | "none";
	customCertificateId: string | null;
	serviceId: string;
	projectId: string;
	organizationId: string;
};

export type ExpiryNotice = {
	/** Fires once per certificate, organization and threshold. */
	dedupeKey: string;
	organizationId: string;
	resource: EventEnvelope["resource"];
	payload: Record<string, unknown>;
};

/**
 * One `certificate.expiring` per certificate and organization at the tightest threshold it
 * has crossed. Managed certificates belong to the organizations whose auto-TLS domains they
 * cover; uploads to their own. Scoped to a service or project only when every covered
 * domain shares it, so a wildcard over fifty services is one message, not fifty.
 */
export function expiryNotices(
	subjects: CertSubject[],
	domains: DomainRef[],
	now: Date,
): ExpiryNotice[] {
	const out: ExpiryNotice[] = [];
	for (const s of subjects) {
		const daysLeft = Math.floor(
			(Date.parse(s.cert.notAfter) - now.getTime()) / DAY,
		);
		const threshold = [...EXPIRY_THRESHOLDS]
			.sort((a, b) => a - b)
			.find((t) => daysLeft <= t);
		if (threshold === undefined || daysLeft < 0) continue;
		const covered =
			s.source === "custom"
				? domains.filter((d) => d.customCertificateId === s.id)
				: domains.filter(
						(d) =>
							d.tls === "auto" &&
							s.cert.names.some((n) => covers(n, d.hostname)),
					);
		const orgs =
			s.source === "custom"
				? [s.organizationId]
				: [...new Set(covered.map((d) => d.organizationId))];
		const label = s.source === "custom" ? s.name : (s.cert.names[0] ?? "?");
		for (const organizationId of orgs) {
			const mine = covered.filter((d) => d.organizationId === organizationId);
			const only = <K extends "serviceId" | "projectId">(k: K) => {
				const ids = new Set(mine.map((d) => d[k]));
				return ids.size === 1 ? [...ids][0] : undefined;
			};
			const certKey = s.source === "custom" ? s.id : s.cert.names.join(",");
			out.push({
				dedupeKey: `ls:cert-expiring:${organizationId}:${certKey}:${s.cert.notAfter}:${threshold}`,
				organizationId,
				resource: { type: "certificate", id: certKey },
				payload: {
					name: label,
					hostname: s.cert.names[0],
					names: s.cert.names,
					issuer: s.cert.issuer,
					expiresAt: s.cert.notAfter,
					daysLeft,
					threshold,
					domains: mine.length,
					...(only("projectId") ? { projectId: only("projectId") } : {}),
					...(only("serviceId") ? { serviceId: only("serviceId") } : {}),
				},
			});
		}
	}
	return out;
}

/** Maintenance pass: refresh the snapshot, then announce certificates nearing expiry. */
export async function checkCertificates(ctx: Ctx, now = new Date()) {
	const managed = await refreshCertSnapshot(ctx);
	const customs = await ctx.db.select().from(certificate);
	const rows = await ctx.db
		.select({
			id: domain.id,
			hostname: domain.hostname,
			https: domain.https,
			cert: domain.cert,
			customCertificateId: domain.customCertificateId,
			serviceId: domain.serviceId,
			projectId: project.id,
			organizationId: project.organizationId,
		})
		.from(domain)
		.innerJoin(service, eq(service.id, domain.serviceId))
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId));
	const subjects: CertSubject[] = [
		...managed.map((cert) => ({ source: "managed" as const, cert })),
		...customs.flatMap((c): CertSubject[] => {
			try {
				return [
					{
						source: "custom",
						cert: describePem(c.certPem),
						id: c.id,
						name: c.name,
						organizationId: c.organizationId,
					},
				];
			} catch {
				return [];
			}
		}),
	];
	const notices = expiryNotices(
		subjects,
		rows.map((r) => ({
			...r,
			tls: !r.https ? "none" : r.cert,
		})),
		now,
	);
	for (const n of notices) {
		const fresh = await ctx.bus.redis.send("SET", [
			n.dedupeKey,
			"1",
			"NX",
			"EX",
			String(60 * 86_400),
		]);
		if (fresh !== "OK") continue;
		await ctx.bus.publish(
			"certificate.expiring",
			n.organizationId,
			n.resource,
			n.payload,
		);
	}
	log("info", "certificates checked", {
		managed: managed.length,
		custom: customs.length,
		expiring: notices.length,
	});
}
