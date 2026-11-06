import { z } from "zod";
import { SecretScope } from "./enums.ts";
import { EnvKey } from "./resources.ts";

/** Values are capped at the boundary; 64 KiB fits certificates and service-account JSON. */
export const SecretValue = z.string().max(65_536);

/** A managed secret's metadata. Values are never part of it: see `POST /secrets/{id}/reveal`. */
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
	updatedBy: z.string().nullable(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});
export type Secret = z.infer<typeof Secret>;

export const SecretInput = z.object({
	scope: SecretScope,
	scopeId: z.string(),
	key: EnvKey,
	value: SecretValue,
	description: z.string().max(500).optional(),
});
export type SecretInput = z.infer<typeof SecretInput>;

export const SecretUpdate = z.object({
	/** A new value becomes a new version. */
	value: SecretValue.optional(),
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
