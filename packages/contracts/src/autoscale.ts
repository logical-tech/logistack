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

export const AutoscaleSettings = z
	.object({
		enabled: z.boolean(),
		minReplicas: z.int().min(1).max(AUTOSCALE_MAX_REPLICAS),
		maxReplicas: z.int().min(1).max(AUTOSCALE_MAX_REPLICAS),
		behavior: AutoscaleBehavior,
		/** Average CPU across replicas, percent of each replica's limit. */
		targetCpu: Percent,
		/** Average memory, percent of the limit; null leaves memory out of the decision. */
		targetMemory: Percent.nullable(),
	})
	.refine((s) => s.minReplicas <= s.maxReplicas, {
		message: "must be at least the minimum",
		path: ["maxReplicas"],
	});
export type AutoscaleSettings = z.infer<typeof AutoscaleSettings>;
