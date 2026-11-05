import { z } from "zod";

const Op = z.enum(["added", "removed", "changed"]);
const SetOp = z.enum(["added", "removed"]);

const PortView = z.object({
	published: z.int().nullable(),
	target: z.int(),
	protocol: z.string(),
	mode: z.string(),
});

const MountView = z.object({
	type: z.string(),
	source: z.string().nullable(),
	readOnly: z.boolean(),
});

/**
 * One difference between the spec of the last healthy deployment and the one the next deploy
 * would apply. Env values are present only for non-secret variables; files never carry content.
 */
export const PendingChange = z.discriminatedUnion("area", [
	z.object({ area: z.literal("image"), before: z.string(), after: z.string() }),
	z.object({
		area: z.literal("env"),
		op: Op,
		key: z.string(),
		/** Values withheld: the variable is secret, or derived from secrets. */
		secret: z.boolean(),
		before: z.string().optional(),
		after: z.string().optional(),
	}),
	z.object({ area: z.literal("domain"), op: SetOp, hostname: z.string() }),
	z.object({
		area: z.literal("resources"),
		/** `cpu` in cores, `memory` in bytes; null is unlimited. */
		resource: z.enum(["cpu", "memory"]),
		before: z.number().nullable(),
		after: z.number().nullable(),
	}),
	z.object({ area: z.literal("replicas"), before: z.int(), after: z.int() }),
	z.object({
		area: z.literal("mount"),
		op: Op,
		target: z.string(),
		before: MountView.optional(),
		after: MountView.optional(),
	}),
	z.object({
		area: z.literal("file"),
		op: Op,
		target: z.string(),
		kind: z.enum(["config", "secret"]),
	}),
	z.object({
		area: z.literal("port"),
		op: Op,
		before: PortView.optional(),
		after: PortView.optional(),
	}),
	z.object({
		area: z.literal("healthcheck"),
		before: z.array(z.string()).nullable(),
		after: z.array(z.string()).nullable(),
	}),
	z.object({ area: z.literal("network"), op: Op, network: z.string() }),
	/** Any other field of the Swarm spec, by its dotted path. */
	z.object({
		area: z.literal("other"),
		path: z.string(),
		before: z.unknown(),
		after: z.unknown(),
	}),
]);
export type PendingChange = z.infer<typeof PendingChange>;

export const PendingDiff = z.object({
	/** The healthy deployment compared against; null when there is none with a recorded spec. */
	baseline: z
		.object({ deploymentId: z.string(), createdAt: z.string() })
		.nullable(),
	changes: z.array(z.object({ summary: z.string(), change: PendingChange })),
});
export type PendingDiff = z.infer<typeof PendingDiff>;
