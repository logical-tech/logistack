import { z } from "zod";

export const gitRefKinds = ["branch", "tag", "release"] as const;
export const GitRefKind = z.enum(gitRefKinds);
export type GitRefKind = z.infer<typeof GitRefKind>;

/** When a git event deploys a service. Watch paths (a separate list) narrow branch pushes further. */
export const GitTrigger = z.object({
	/** `branch`: pushes to the source branch. `tag`: tag pushes matching `tagPattern`. `release`: published releases whose tag matches. */
	on: GitRefKind.default("branch"),
	/** Glob over the tag name, e.g. `v*.*.*`. Ignored for branch pushes. */
	tagPattern: z.string().trim().min(1).max(200).default("*"),
	/** Hold the deployment until the commit's CI checks pass; skip it when they fail or time out. */
	waitForChecks: z.boolean().default(false),
	checksTimeoutMinutes: z.int().min(1).max(720).default(30),
});
export type GitTrigger = z.infer<typeof GitTrigger>;
