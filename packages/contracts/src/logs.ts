import { z } from "zod";

// Deployment logs: the worker RPUSHes each line to deploymentLogKey(id), then PUBLISHes it on
// deploymentLogChannel(id) with `seq` = its list index. A reader subscribes, reads the list, and
// keeps only published lines with seq >= the list length it read: no gap, no duplicate.

export const deploymentLogKey = (deploymentId: string) =>
	`ls:logs:deployment:${deploymentId}:lines`;
export const deploymentLogChannel = (deploymentId: string) =>
	`ls:logs:deployment:${deploymentId}`;
/** Kept a week after the last line; the worker's log file stays the long-term copy. */
export const DEPLOYMENT_LOG_TTL_SEC = 7 * 86_400;

export const DeploymentLogLine = z.object({
	seq: z.number().int().nonnegative(),
	line: z.string(),
	at: z.string(),
});
export type DeploymentLogLine = z.infer<typeof DeploymentLogLine>;
