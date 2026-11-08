import { z } from "zod";

/** GitHub repository whose releases LogiStack updates to. */
export const RELEASES_REPO = "logical-tech/logistack";
/** Where release images live: `<registry>/logistack:<version>` and its siblings. */
export const RELEASE_REGISTRY = "ghcr.io/logical-tech";

/**
 * The stack services an update replaces, in the order it replaces them, after the `migrate` step
 * has applied the new schema. The api goes first so agents and the worker meet a server that
 * already speaks their version; the worker goes last, once nothing runs on it.
 */
export const UPDATE_TARGETS = [
	{ step: "logistack-api", image: "logistack" },
	{ step: "logistack-agent", image: "logistack-agent" },
	{ step: "caddy", image: "logistack-caddy" },
	{ step: "logistack-worker", image: "logistack-worker" },
] as const;

/**
 * `drain` pauses the deploy, backup and migration queues and waits for running jobs to finish;
 * `migrate` runs the new release's migrations once, from its api image, before any of it serves.
 */
export const updateSteps = [
	"pull",
	"drain",
	"migrate",
	...UPDATE_TARGETS.map((t) => t.step),
] as const;
export const UpdateStep = z.enum(updateSteps);
export type UpdateStep = z.infer<typeof UpdateStep>;

export const UpdateStepState = z.enum([
	"pending",
	"running",
	"done",
	"failed",
	"rolled_back",
]);
export type UpdateStepState = z.infer<typeof UpdateStepState>;
export const UpdateSteps = z.partialRecord(UpdateStep, UpdateStepState);
export type UpdateSteps = z.infer<typeof UpdateSteps>;

export const UpdateState = z.enum(["queued", "running", "succeeded", "failed"]);
export type UpdateState = z.infer<typeof UpdateState>;

export const updateChannel = (id: string) => `instance-update:${id}`;

/** The fields of GitHub's release object LogiStack reads. Parsed at the boundary. */
export const GithubRelease = z.object({
	tag_name: z.string(),
	name: z.string().nullable(),
	body: z.string().nullable(),
	html_url: z.url(),
	published_at: z.string().nullable(),
	draft: z.boolean(),
	prerelease: z.boolean(),
});
export type GithubRelease = z.infer<typeof GithubRelease>;

/**
 * Which builds an instance is offered: `stable` tags only, `beta` adds the prereleases built from
 * `staging` (`-beta.N`), `nightly` adds the daily builds of `develop` (`-nightly.N`).
 */
export const ReleaseChannel = z.enum(["stable", "beta", "nightly"]);
export type ReleaseChannel = z.infer<typeof ReleaseChannel>;
