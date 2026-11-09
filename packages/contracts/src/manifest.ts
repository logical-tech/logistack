import { z } from "zod";
import { AutoscaleInput } from "./autoscale.ts";
import {
	BackupTarget,
	CertMode,
	DesiredState,
	EnvironmentColor,
	EnvironmentKind,
	SecretScope,
} from "./enums.ts";
import { BackupRetention } from "./operations.ts";
import { EnvKey, Hostname } from "./resources.ts";
import { ServiceIcon } from "./service-icon.ts";
import { ServiceSpec, StackGitSource } from "./service-spec.ts";

/** Bumped on a change an older server cannot read; servers refuse versions they do not know. */
export const MANIFEST_VERSION = 1;

const Slug = z
	.string()
	.min(1)
	.max(63)
	.regex(
		/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
		"lowercase letters, digits and dashes",
	);
const Name = z.string().trim().min(1).max(100);
/** An organization resource (git provider, S3 destination, DNS provider, certificate), by its name. */
const Ref = z.string().min(1).max(100);

export const ManifestVariable = z
	.object({
		key: EnvKey,
		value: z
			.string()
			.optional()
			.describe(
				"Never exported for a secret. On apply, a secret without a value keeps the stored one.",
			),
		secret: z.boolean().default(false),
		buildTime: z.boolean().default(false),
		secretRef: z
			.object({
				key: EnvKey,
				scope: SecretScope.optional().describe(
					"Where the secret is defined. Left out, the most specific scope on the service's chain that defines the key.",
				),
			})
			.optional()
			.describe(
				"Service variables only: reference a managed secret by name instead of carrying a value. The secret's value never appears in the manifest.",
			),
		asFile: z
			.boolean()
			.optional()
			.describe(
				"A secret mounted as /run/secrets/<key> (a Swarm secret) instead of an env var; <key>_FILE holds the path.",
			),
	})
	.refine((v) => v.secret || v.secretRef || v.value !== undefined, {
		message: "a variable that is not secret needs a value",
		path: ["value"],
	})
	.refine((v) => !(v.secretRef && v.value !== undefined), {
		message: "a secret reference carries no value",
		path: ["value"],
	})
	.refine((v) => !v.asFile || v.secret || v.secretRef, {
		message: "only a secret can be mounted as a file",
		path: ["asFile"],
	})
	.meta({ id: "ManifestVariable" });
export type ManifestVariable = z.infer<typeof ManifestVariable>;

export const ManifestMount = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("volume"),
			target: z.string().startsWith("/"),
			name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
		}),
		z.object({
			kind: z.literal("config"),
			target: z.string().startsWith("/"),
			content: z.string(),
		}),
	])
	.meta({ id: "ManifestMount" });
export type ManifestMount = z.infer<typeof ManifestMount>;

export const ManifestDomain = z
	.object({
		hostname: Hostname,
		port: z.int().min(1).max(65535),
		pathPrefix: z
			.string()
			.regex(/^\/[^\s{}]*$/, "a path starting with /, without spaces or braces")
			.optional(),
		https: z.boolean(),
		cert: CertMode,
		certificate: Ref.optional().describe(
			"Name of an uploaded certificate; required with cert 'custom'.",
		),
		redirectTo: Hostname.optional(),
		dnsProvider: Ref.optional().describe("Name of a DNS provider."),
		tunnel: z.boolean().default(false),
	})
	.refine((d) => (d.cert === "custom") === Boolean(d.certificate), {
		message:
			"certificate is required for, and only allowed with, cert 'custom'",
		path: ["certificate"],
	})
	.meta({ id: "ManifestDomain" });
export type ManifestDomain = z.infer<typeof ManifestDomain>;

export const ManifestBackup = z
	.object({
		target: BackupTarget,
		volume: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Volume backups: the mount target, or `data` for a database's data directory.",
			),
		destination: Ref.describe("Name of an S3 destination."),
		cron: z.string().min(1),
		timezone: z.string().min(1).default("UTC"),
		retention: BackupRetention,
		verifyCron: z.string().min(1).optional(),
		pauseService: z.boolean().default(false),
		enabled: z.boolean().default(true),
		encrypt: z
			.boolean()
			.default(false)
			.describe(
				"Encrypt with an age key. A policy created by apply gets a new key, returned once.",
			),
	})
	.refine((b) => (b.target === "volume") === Boolean(b.volume), {
		message: "volume is required for, and only allowed with, target 'volume'",
		path: ["volume"],
	})
	.meta({ id: "ManifestBackup" });
export type ManifestBackup = z.infer<typeof ManifestBackup>;

export const ManifestService = z
	.object({
		name: Name,
		slug: Slug.describe("Identity: apply matches services by slug."),
		icon: ServiceIcon.optional(),
		desiredState: DesiredState.default("running"),
		spec: ServiceSpec.describe(
			"As the API takes it, except a git source names its provider in `gitProvider`, not by id.",
		),
		gitProvider: Ref.optional().describe(
			"Name of the git provider a git source pulls through.",
		),
		stack: Slug.optional().describe(
			"The git stack that creates this service; apply leaves creating it to the stack.",
		),
		variables: z.array(ManifestVariable).default([]),
		mounts: z.array(ManifestMount).default([]),
		domains: z.array(ManifestDomain).default([]),
		backups: z.array(ManifestBackup).default([]),
		autoscale: AutoscaleInput.optional().describe(
			"Application services only. Left out, apply keeps the current autoscaling.",
		),
	})
	.refine(
		(s) =>
			!("source" in s.spec) ||
			s.spec.source.type !== "git" ||
			s.spec.source.gitProviderId === undefined,
		{
			message: "name the provider in gitProvider instead",
			path: ["spec", "source", "gitProviderId"],
		},
	)
	.meta({ id: "ManifestService" });
export type ManifestService = z.infer<typeof ManifestService>;

export const ManifestStack = z
	.object({
		name: Slug,
		git: StackGitSource.omit({ gitProviderId: true }).extend({
			gitProvider: Ref,
		}),
	})
	.meta({ id: "ManifestStack" });
export type ManifestStack = z.infer<typeof ManifestStack>;

/** Duplicate keys within one list; apply matches by them, so each must be unique. */
function unique<T>(
	ctx: z.RefinementCtx,
	items: readonly T[],
	key: (t: T) => string,
	path: (string | number)[],
	what: string,
) {
	const seen = new Set<string>();
	for (const item of items) {
		const k = key(item);
		if (seen.has(k))
			ctx.addIssue({ code: "custom", message: `duplicate ${what} ${k}`, path });
		seen.add(k);
	}
}

export const domainKey = (d: { hostname: string; pathPrefix?: string }) =>
	`${d.hostname}${d.pathPrefix ?? ""}`;
export const backupKey = (b: ManifestBackup) =>
	[b.target, b.volume, b.destination, b.cron].filter(Boolean).join(" ");

export const ManifestEnvironment = z
	.object({
		name: Name,
		slug: Slug,
		kind: EnvironmentKind,
		color: EnvironmentColor.optional(),
		variables: z.array(ManifestVariable).default([]),
		stacks: z.array(ManifestStack).default([]),
		services: z.array(ManifestService).default([]),
	})
	.superRefine((e, ctx) => {
		unique(ctx, e.variables, (v) => v.key, ["variables"], "variable");
		unique(ctx, e.stacks, (s) => s.name, ["stacks"], "stack");
		unique(ctx, e.services, (s) => s.slug, ["services"], "service");
		const stacks = new Set(e.stacks.map((s) => s.name));
		e.services.forEach((s, i) => {
			const at = ["services", i];
			if (s.stack && !stacks.has(s.stack))
				ctx.addIssue({
					code: "custom",
					message: `unknown stack ${s.stack}`,
					path: [...at, "stack"],
				});
			unique(ctx, s.variables, (v) => v.key, [...at, "variables"], "variable");
			unique(ctx, s.mounts, (m) => m.target, [...at, "mounts"], "mount");
			unique(ctx, s.domains, domainKey, [...at, "domains"], "domain");
			unique(ctx, s.backups, backupKey, [...at, "backups"], "backup");
		});
	})
	.meta({ id: "ManifestEnvironment" });
export type ManifestEnvironment = z.infer<typeof ManifestEnvironment>;

const Version = z
	.literal(MANIFEST_VERSION)
	.describe("Manifest format version.");

export const EnvironmentManifest = z.object({
	version: Version,
	kind: z.literal("environment"),
	environment: ManifestEnvironment,
});
export type EnvironmentManifest = z.infer<typeof EnvironmentManifest>;

export const ProjectManifest = z
	.object({
		version: Version,
		kind: z.literal("project"),
		project: z.object({
			name: Name,
			description: z.string().max(1000).optional(),
		}),
		variables: z.array(ManifestVariable).default([]),
		environments: z.array(ManifestEnvironment).default([]),
	})
	.superRefine((p, ctx) => {
		unique(ctx, p.variables, (v) => v.key, ["variables"], "variable");
		unique(ctx, p.environments, (e) => e.slug, ["environments"], "environment");
	});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

/**
 * The desired state of a project or one environment, as LogiStack exports it and `apply` takes it.
 * Secret values are never exported; organization resources are referenced by name.
 */
export const Manifest = z
	.discriminatedUnion("kind", [EnvironmentManifest, ProjectManifest])
	.meta({
		id: "LogiStackManifest",
		title: "LogiStack manifest",
		description:
			"The desired state of a LogiStack project or environment. Export it, keep it in git, apply it from CI.",
	});
export type Manifest = z.infer<typeof Manifest>;

/** JSON Schema of what a manifest file may contain, for editors (`yaml-language-server`). */
export const manifestJsonSchema = () =>
	z.toJSONSchema(Manifest, { io: "input", unrepresentable: "any" });

export const manifestChangeResources = [
	"project",
	"environment",
	"variable",
	"stack",
	"service",
	"domain",
	"backup",
] as const;
export type ManifestChangeResource = (typeof manifestChangeResources)[number];

export const ManifestChange = z.object({
	op: z.enum(["create", "update", "delete"]),
	resource: z.enum(manifestChangeResources),
	/** Environment slug, for anything inside one. */
	environment: z.string().optional(),
	/** Service slug, for a domain, backup or variable of a service. */
	service: z.string().optional(),
	/** The resource's identity: a slug, a variable key, a hostname, a backup's target and cron. */
	name: z.string(),
	/** What differs, one line each; never a secret's value. */
	changes: z.array(z.string()),
});
export type ManifestChange = z.infer<typeof ManifestChange>;
