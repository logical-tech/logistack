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

/**
 * What every deployment injects into its containers and, as build args, into Dockerfile builds.
 * The whole prefix is reserved so a variable added later never collides with a stored one.
 */
export const RESERVED_ENV_PREFIX = "LOGISTACK_";
export const deploymentContextVars = {
	LOGISTACK_DEPLOYMENT_ID: "The deployment that started this container.",
	LOGISTACK_COMMIT_SHA: "Full hash of the deployed commit. Git sources only.",
	LOGISTACK_COMMIT_MESSAGE:
		"First line of the commit message, up to 200 characters. Git sources only.",
	LOGISTACK_BRANCH: "Branch the commit was built from. Git sources only.",
	LOGISTACK_ENVIRONMENT: "Name of the environment.",
	LOGISTACK_PROJECT: "Name of the project.",
	LOGISTACK_SERVICE: "Name of the service.",
	LOGISTACK_URL:
		"Primary domain with its scheme, such as https://app.example.com. Unset without a domain.",
	LOGISTACK_FQDN:
		"Every hostname the service answers on, comma-separated. Unset without a domain.",
	LOGISTACK_PREVIEW_URL:
		"Pull request previews only: the preview's main URL, that of the first followed service with a domain.",
	"LOGISTACK_PREVIEW_URL_<SERVICE>":
		"Pull request previews only: the URL of each exposed service of the preview, stack services included, by its name in upper case with dashes as underscores, such as LOGISTACK_PREVIEW_URL_API.",
} as const satisfies Record<`${typeof RESERVED_ENV_PREFIX}${string}`, string>;
export type DeploymentContextVar = keyof typeof deploymentContextVars;

export const isReservedEnvKey = (key: string) =>
	key.startsWith(RESERVED_ENV_PREFIX);

export const reservedEnvKeyMessage = (key: string) =>
	`${key}: names starting with ${RESERVED_ENV_PREFIX} are reserved for the variables LogiStack sets on every deployment`;

export const EnvVar = z.object({
	id: z.string(),
	scope: EnvVarScope,
	scopeId: z.string(),
	key: EnvKey,
	/** null when the value is masked (secret and caller lacks `read:secrets`). */
	value: z.string().nullable(),
	isSecret: z.boolean(),
	isBuildTime: z.boolean(),
	/** Set when the value comes from a managed secret; `value` is then always null. */
	secretId: z.string().nullable(),
	/** A secret reference mounted as `/run/secrets/<key>` instead of an env var; `<key>_FILE` holds the path. */
	asFile: z.boolean().default(false),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});
export type EnvVar = z.infer<typeof EnvVar>;

export const EnvVarInput = z.object({
	key: EnvKey,
	// References resolve only through a secret (POST /secrets or a service's variables).
	value: z
		.string()
		.refine(
			(v) => !v.startsWith("secret://"),
			"secret:// references belong in a secret: create one with this reference and reference it from the service",
		),
	isSecret: z.boolean(),
	isBuildTime: z.boolean(),
});
export type EnvVarInput = z.infer<typeof EnvVarInput>;
