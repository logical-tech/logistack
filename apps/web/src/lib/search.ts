import { MetricRange } from "@logistack/contracts";
import { z } from "zod";

/** Same-origin path only: rejects `//host` and `/\host`, which browsers treat as external. */
export const redirectParam = z
	.string()
	.regex(/^\/(?![/\\])/)
	.optional()
	.catch(undefined);

export const stepParam = z.string().optional();

/** Metrics range in the URL, so a chart view is shareable; 24h when absent or invalid. */
export const rangeParam = MetricRange.optional().catch(undefined);
