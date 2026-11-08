import { z } from "zod";

export const AUTOSCALE_MAX_REPLICAS = 20;

/** Presets set only the CPU target; `custom` keeps the stored targets. */
export const autoscaleBehaviors = [
	"responsive",
	"balanced",
	"economical",
	"custom",
] as const;
export const AutoscaleBehavior = z.enum(autoscaleBehaviors);
export type AutoscaleBehavior = z.infer<typeof AutoscaleBehavior>;

const Percent = z.int().min(10).max(95);

const Range = {
	minReplicas: z.int().min(1).max(AUTOSCALE_MAX_REPLICAS),
	maxReplicas: z.int().min(1).max(AUTOSCALE_MAX_REPLICAS),
};
const rangeOk = (s: { minReplicas: number; maxReplicas: number }) =>
	s.minReplicas <= s.maxReplicas;
const rangeError = {
	message: "must be at least the minimum",
	path: ["maxReplicas"],
};

export const AutoscaleSettings = z.object({
	enabled: z.boolean(),
	...Range,
	behavior: AutoscaleBehavior,
	/** Average CPU across replicas, percent of each replica's limit. */
	targetCpu: Percent,
	/** Average memory, percent of the limit; null leaves memory out of the decision. */
	targetMemory: Percent.nullable(),
});
export type AutoscaleSettings = z.infer<typeof AutoscaleSettings>;

/** A preset sets `targetCpu` itself; `custom` needs one. */
export const AutoscaleInput = z
	.object({
		enabled: z.boolean(),
		...Range,
		behavior: AutoscaleBehavior.default("balanced"),
		targetCpu: Percent.optional().describe(
			"Only with behavior `custom`; presets set it: responsive 45, balanced 60, economical 75.",
		),
		targetMemory: Percent.nullable()
			.default(null)
			.describe("Needs a memory limit; null leaves memory out."),
	})
	.refine(rangeOk, rangeError)
	.refine((s) => s.behavior !== "custom" || s.targetCpu !== undefined, {
		message: "required with behavior 'custom'",
		path: ["targetCpu"],
	})
	.meta({ id: "AutoscaleInput" });
export type AutoscaleInput = z.infer<typeof AutoscaleInput>;

export const autoscaleCheckIds = [
	"cpu_limit",
	"volumes",
	"host_ports",
	"healthcheck",
	"nodes",
] as const;

export const autoscaleFixIds = [
	"apply_profile",
	"ingress_ports",
	"add_healthcheck",
] as const;
export const AutoscaleFixId = z.enum(autoscaleFixIds);
export type AutoscaleFixId = z.infer<typeof AutoscaleFixId>;

/** A one-click change that makes a failed check pass; the server recomputes it when applied. */
export const AutoscaleFix = z
	.object({
		id: AutoscaleFixId,
		title: z.string(),
		summary: z.string(),
		/** Shown as before → after rows. */
		changes: z.array(
			z.object({ label: z.string(), before: z.string(), after: z.string() }),
		),
		/** Side effects and the evidence behind the choice. */
		notes: z.array(z.string()),
		/** Applying it starts a deployment. */
		redeploy: z.boolean(),
		/** The fix is only offered after a live test passes: call its probe before applying. */
		probe: z.boolean().optional(),
	})
	.meta({ id: "AutoscaleFix" });
export type AutoscaleFix = z.infer<typeof AutoscaleFix>;

/** One readiness check; a failed `blocker` refuses enabling, a failed `warning` only informs. */
export const AutoscaleCheck = z.object({
	id: z.enum(autoscaleCheckIds),
	level: z.enum(["blocker", "warning"]),
	ok: z.boolean(),
	message: z.string(),
	/** Present on a failed check that one click can fix. */
	fix: AutoscaleFix.optional(),
	/** Why the known fix for this check can't apply right now. */
	fixUnavailable: z.string().optional(),
	/** Where the user fixes it by hand when no click can, e.g. adding a server. */
	link: z.object({ label: z.string(), to: z.string() }).optional(),
});
export type AutoscaleCheck = z.infer<typeof AutoscaleCheck>;

export const AutoscaleView = AutoscaleSettings.extend({
	/** False until settings were first saved; the rest are then defaults. */
	configured: z.boolean(),
	/** The autoscaler's current count; null before its first decision. */
	replicas: z.int().nullable(),
	lastScaledAt: z.coerce.date().nullable(),
	lastReason: z.string().nullable(),
	checks: z.array(AutoscaleCheck),
}).meta({ id: "AutoscaleView" });
export type AutoscaleView = z.infer<typeof AutoscaleView>;

/** What these settings would have done over the last day, one point per minute with data. */
export const AutoscalePreview = z
	.object({
		points: z.array(
			z.object({
				at: z.coerce.date(),
				replicas: z.int(),
				/** CPU at the simulated count, percent of the limit. */
				cpu: z.number(),
			}),
		),
		/** Under an hour of samples: too little to show. */
		enoughData: z.boolean(),
	})
	.meta({ id: "AutoscalePreview" });
export type AutoscalePreview = z.infer<typeof AutoscalePreview>;

export const AutoscalePreviewQuery = z
	.object({
		minReplicas: z.coerce.number().pipe(Range.minReplicas),
		maxReplicas: z.coerce.number().pipe(Range.maxReplicas),
		behavior: AutoscaleBehavior.default("balanced"),
		targetCpu: z.coerce.number().pipe(Percent).optional(),
	})
	.refine(rangeOk, rangeError);
export type AutoscalePreviewQuery = z.infer<typeof AutoscalePreviewQuery>;

/** Payload of the `service.scaled` event; `cpu` and `memory` are percent of the limit. */
export const ServiceScaledEventPayload = z.object({
	serviceId: z.string(),
	service: z.string(),
	from: z.int(),
	to: z.int(),
	reason: z.string(),
	cpu: z.number().nullable(),
	memory: z.number().nullable(),
});
export type ServiceScaledEventPayload = z.infer<
	typeof ServiceScaledEventPayload
>;

/** After an AutoFix: the fresh view and the deployment it queued (null when nothing changed). */
export const AutoscaleFixResult = z
	.object({ view: AutoscaleView, deploymentId: z.string().nullable() })
	.meta({ id: "AutoscaleFixResult" });
export type AutoscaleFixResult = z.infer<typeof AutoscaleFixResult>;

/** A fix re-planned after its live test: the fix with the evidence, or why it isn't offered. */
export const AutoscaleFixProbe = z
	.object({ fix: AutoscaleFix.optional(), unavailable: z.string().optional() })
	.meta({ id: "AutoscaleFixProbe" });
export type AutoscaleFixProbe = z.infer<typeof AutoscaleFixProbe>;
