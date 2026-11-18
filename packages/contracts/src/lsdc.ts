import { z } from "zod";

/** Limits of a managed LSDC instance: CPU and RAM on the container, storage enforced by LSDC. */
export const LsdcLimits = z.object({
	/** Cores, fractional allowed. */
	cpu: z.number().min(0.1).max(64),
	ramMb: z.int().min(128).max(262_144),
	storageMb: z.int().min(64).max(10_000_000),
});
export type LsdcLimits = z.infer<typeof LsdcLimits>;

const Currency = z.string().regex(/^[A-Z]{3}$/, "a 3-letter currency code");

export const LsdcInstance = z.object({
	/** The stack id: one stack per instance. */
	id: z.string(),
	serviceId: z.string(),
	name: z.string(),
	projectId: z.string(),
	projectName: z.string(),
	environmentId: z.string(),
	environmentName: z.string(),
	hostname: z.string().nullable(),
	desiredState: z.enum(["running", "stopped"]),
	customer: z.string().nullable(),
	priceCents: z.int().nullable(),
	currency: z.string(),
	/** Null fields are unlimited. */
	limits: z.object({
		cpu: z.number().nullable(),
		ramMb: z.int().nullable(),
		storageMb: z.int().nullable(),
	}),
	/** LSDC_ENV_TYPE=managed: the customer cannot update or download backups. */
	managed: z.boolean(),
	createdAt: z.string(),
});
export type LsdcInstance = z.infer<typeof LsdcInstance>;

/** Read live from the instance's `GET /api/instance/usage` with its management key. */
export const LsdcUsage = z.discriminatedUnion("reachable", [
	z.object({
		reachable: z.literal(true),
		cpu: z.number().nullable(),
		ramMb: z.number().nullable(),
		storageMb: z.number(),
	}),
	z.object({ reachable: z.literal(false), reason: z.string() }),
]);
export type LsdcUsage = z.infer<typeof LsdcUsage>;

export const LsdcProvisionInput = z.object({
	customer: z.string().trim().min(1).max(100),
	/** Empty: a generated hostname. */
	domain: z.string().trim().max(253).default(""),
	/** Empty: the instance starts with its setup wizard. */
	adminEmail: z.union([z.email(), z.literal("")]).default(""),
	blueprintUrl: z
		.union([z.url({ protocol: /^https$/ }), z.literal("")])
		.default(""),
	limits: LsdcLimits,
	priceCents: z.int().min(0).nullable().default(null),
	currency: Currency.default("EUR"),
});
export type LsdcProvisionInput = z.infer<typeof LsdcProvisionInput>;

export const LsdcProvisionResult = z.object({
	instance: LsdcInstance,
	/** Shown once: the first admin's generated password, when adminEmail was given. */
	adminPassword: z.string().nullable(),
});
export type LsdcProvisionResult = z.infer<typeof LsdcProvisionResult>;

export const LsdcInstanceUpdate = z
	.object({
		customer: z.string().trim().min(1).max(100).nullable(),
		priceCents: z.int().min(0).nullable(),
		currency: Currency,
		/** Changing limits redeploys the instance. */
		limits: LsdcLimits,
	})
	.partial();
export type LsdcInstanceUpdate = z.infer<typeof LsdcInstanceUpdate>;
