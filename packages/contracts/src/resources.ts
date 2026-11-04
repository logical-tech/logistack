import { z } from "zod";
import { CertMode, DomainStatus, EnvVarScope } from "./enums.ts";

export const Hostname = z
	.string()
	.max(253)
	.toLowerCase()
	.regex(
		/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
		"invalid hostname",
	);

const PathPrefix = z.string().startsWith("/");

export const Domain = z.object({
	id: z.string(),
	serviceId: z.string(),
	hostname: Hostname,
	port: z.int().min(1).max(65535),
	pathPrefix: PathPrefix.nullable(),
	https: z.boolean(),
	cert: CertMode,
	customCertificateId: z.string().nullable(),
	redirectTo: Hostname.nullable(),
	isGenerated: z.boolean(),
	dnsProviderId: z.string().nullable(),
	dnsRecordId: z.string().nullable(),
	/** Served through the Cloudflare Tunnel of `dnsProviderId`, not a public port. */
	tunnel: z.boolean(),
	status: DomainStatus,
	statusMessage: z.string().nullable(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});
export type Domain = z.infer<typeof Domain>;

export const DomainInput = z
	.object({
		hostname: Hostname,
		port: z.int().min(1).max(65535),
		pathPrefix: PathPrefix.nullable().optional(),
		https: z.boolean(),
		cert: CertMode,
		customCertificateId: z.string().nullable().optional(),
		redirectTo: Hostname.nullable().optional(),
		dnsProviderId: z.string().nullable().optional(),
		/** Route through the provider's Cloudflare Tunnel; Cloudflare terminates TLS. */
		tunnel: z.boolean().optional(),
	})
	.refine((d) => (d.cert === "custom") === Boolean(d.customCertificateId), {
		message:
			"customCertificateId is required for, and only allowed with, cert 'custom'",
		path: ["customCertificateId"],
	});
export type DomainInput = z.infer<typeof DomainInput>;

export const EnvKey = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "invalid environment variable name");

export const EnvVar = z.object({
	id: z.string(),
	scope: EnvVarScope,
	scopeId: z.string(),
	key: EnvKey,
	/** null when the value is masked (secret and caller lacks `read:secrets`). */
	value: z.string().nullable(),
	isSecret: z.boolean(),
	isBuildTime: z.boolean(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});
export type EnvVar = z.infer<typeof EnvVar>;

export const EnvVarInput = z.object({
	key: EnvKey,
	value: z.string(),
	isSecret: z.boolean(),
	isBuildTime: z.boolean(),
});
export type EnvVarInput = z.infer<typeof EnvVarInput>;
