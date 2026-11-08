import { z } from "zod";
import { SecretProviderKind, SecretScope } from "./enums.ts";
import { EnvKey } from "./resources.ts";

export const SECRET_REFERENCE_SCHEME = "secret://";

/** `secret://<provider>/<path>#<key>`, split and percent-decoded. */
export type SecretReference = { provider: string; path: string[]; key: string };

/** A provider's name as written in references. */
export const SecretProviderName = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9-]{0,62}$/,
		"lowercase letters, digits and dashes, starting with a letter or digit",
	);

export const isSecretReference = (value: string) =>
	value.startsWith(SECRET_REFERENCE_SCHEME);

const decode = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return null;
	}
};

/** Parses a reference; the error is a sentence for the person who typed it. */
export function parseSecretReference(
	value: string,
): { ok: true; ref: SecretReference } | { ok: false; error: string } {
	const fail = (error: string) => ({ ok: false as const, error });
	if (!isSecretReference(value))
		return fail(`a reference starts with ${SECRET_REFERENCE_SCHEME}`);
	if (value.length > 1024)
		return fail("a reference is at most 1024 characters");
	const rest = value.slice(SECRET_REFERENCE_SCHEME.length);
	const hash = rest.indexOf("#");
	if (hash < 0) return fail("add #<key> after the path");
	const [provider, ...raw] = rest.slice(0, hash).split("/");
	if (!provider || !SecretProviderName.safeParse(provider).success)
		return fail("start with the provider's name: secret://<provider>/...");
	if (!raw.length || raw.some((p) => p === ""))
		return fail("the path has an empty segment");
	const path = raw.map(decode);
	if (path.some((p) => p === null || p === "." || p === ".."))
		return fail("the path has an invalid segment");
	const key = decode(rest.slice(hash + 1));
	if (!key) return fail("the key after # is empty or invalid");
	return { ok: true, ref: { provider, path: path as string[], key } };
}

/** The canonical string form; `path` and `key` are percent-encoded where needed. */
export const formatSecretReference = ({
	provider,
	path,
	key,
}: SecretReference) =>
	`${SECRET_REFERENCE_SCHEME}${provider}/${path.map(encodeURIComponent).join("/")}#${encodeURIComponent(key)}`;

/** The part after the provider name, as stored on the secret: `<path>#<key>`. */
export const secretReferenceTail = (ref: SecretReference) =>
	formatSecretReference(ref).slice(
		SECRET_REFERENCE_SCHEME.length + ref.provider.length + 1,
	);

/** What each provider kind expects in the path; null when it fits. */
export function secretReferenceIssue(
	kind: SecretProviderKind,
	ref: SecretReference,
): string | null {
	switch (kind) {
		case "vault":
			return ref.path.length >= 2
				? null
				: "Vault references read secret://<provider>/<mount>/<path>#<field>";
		case "infisical":
			return ref.path.length >= 1
				? null
				: "Infisical references read secret://<provider>/<environment>[/<folder>...]#<name>";
		case "onepassword":
			return ref.path.length === 2
				? null
				: "1Password references read secret://<provider>/<vault>/<item>#<field>";
		case "plugin":
			// The plugin judges its own paths when it reads.
			return null;
	}
}

export const SecretReferenceString = z
	.string()
	.trim()
	.superRefine((v, ctx) => {
		const r = parseSecretReference(v);
		if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
	});

/** Values are capped at the boundary; 64 KiB fits certificates and service-account JSON. */
export const SecretValue = z.string().max(65_536);

/** A managed secret's metadata. Values are never part of it: see `POST /secrets/{id}/reveal`. */
/** A secret whose value lives in an external provider and is read at deploy time. */
export const SecretExternal = z.object({
	providerId: z.string(),
	providerName: z.string(),
	kind: SecretProviderKind,
	/** `secret://<provider>/<path>#<key>` */
	reference: z.string(),
	/** Last time the worker read it (deploy or periodic check). */
	checkedAt: z.coerce.date().nullable(),
	/** Why the last read failed; null after a successful one. */
	error: z.string().nullable(),
});
export type SecretExternal = z.infer<typeof SecretExternal>;

export const Secret = z.object({
	id: z.string(),
	scope: SecretScope,
	scopeId: z.string(),
	key: EnvKey,
	description: z.string().nullable(),
	/** The current version number; every change adds one. */
	version: z.int(),
	/** Service variables that reference it. */
	usedBy: z.int(),
	/** Set when the value lives in an external provider; such a secret has no versions. */
	external: SecretExternal.nullable(),
	updatedBy: z.string().nullable(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});
export type Secret = z.infer<typeof Secret>;

export const SecretInput = z
	.object({
		scope: SecretScope,
		scopeId: z.string(),
		key: EnvKey,
		/** A value to store, encrypted and versioned. */
		value: SecretValue.optional(),
		/** Or a `secret://<provider>/<path>#<key>` reference to read at deploy time. */
		reference: SecretReferenceString.optional(),
		description: z.string().max(500).optional(),
	})
	.refine(
		(v) => (v.value === undefined) !== (v.reference === undefined),
		"set exactly one of value and reference",
	);
export type SecretInput = z.infer<typeof SecretInput>;

export const SecretUpdate = z.object({
	/** A new value becomes a new version. */
	value: SecretValue.optional(),
	/** External secrets only: point at another location. */
	reference: SecretReferenceString.optional(),
	description: z.string().max(500).nullable().optional(),
});

export const SecretVersion = z.object({
	version: z.int(),
	createdBy: z.string().nullable(),
	createdAt: z.coerce.date(),
	current: z.boolean(),
});

export const SecretReveal = z.object({ version: z.int(), value: z.string() });

export const SecretUsage = z.object({
	envVarId: z.string(),
	/** The name the service's containers see. */
	key: EnvKey,
	serviceId: z.string(),
	serviceName: z.string(),
	environmentId: z.string(),
	projectId: z.string(),
});

/** A secret a service may reference, with where it is defined. */
export const AvailableSecret = Secret.extend({
	/** Name of the folder, project, environment or service that defines it ("" for the organization). */
	scopeName: z.string(),
	/** A more specific scope in the chain defines the same key. */
	shadowed: z.boolean(),
});
export type AvailableSecret = z.infer<typeof AvailableSecret>;

/** Connection settings per kind. Fields marked secret are encrypted at rest and never returned. */
export const SecretProviderView = z.object({
	id: z.string(),
	kind: SecretProviderKind,
	/** Kind `plugin`: the install contributing it and the provider's name in its manifest. */
	pluginInstallId: z.string().nullable(),
	pluginProvider: z.string().nullable(),
	name: SecretProviderName,
	/** The server it talks to, for display. */
	url: z.string(),
	/** External secrets that read from it. */
	secrets: z.int(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});
export type SecretProviderView = z.infer<typeof SecretProviderView>;
