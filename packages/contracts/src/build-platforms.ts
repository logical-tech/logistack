import { z } from "zod";
import { BuildPlatform } from "./service-spec.ts";

/** What the worker last learned about the BuildKit service; stored on the instance settings. */
export const BuildkitState = z.object({
	/** `os/arch[/variant]` the BuildKit worker builds for, native first; null until probed. */
	platforms: z.array(z.string()).nullable(),
	checkedAt: z.string().nullable(),
	/** Why the last probe failed. */
	error: z.string().nullable(),
	/** The guided QEMU setup: absent until someone runs it. */
	emulation: z
		.object({
			state: z.enum(["installing", "installed", "failed"]),
			error: z.string().nullable(),
			at: z.string(),
		})
		.nullable(),
});
export type BuildkitState = z.infer<typeof BuildkitState>;

export const emptyBuildkitState: BuildkitState = {
	platforms: null,
	checkedAt: null,
	error: null,
	emulation: null,
};

export const BuildPlatforms = z.object({
	/** The architectures of the swarm's nodes: what an automatic build targets. */
	swarm: z.array(BuildPlatform),
	buildkit: BuildkitState,
	/** Selectable platforms BuildKit cannot build yet; empty when it can build them all (or before a probe). */
	missing: z.array(BuildPlatform),
});
export type BuildPlatforms = z.infer<typeof BuildPlatforms>;
