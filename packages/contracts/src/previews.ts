import { z } from "zod";
import { EnvKey } from "./resources.ts";

/** Tokens a preview domain pattern may use; `{number}` is required so each pull request gets its own host. */
export const PREVIEW_PATTERN_TOKENS = ["{number}", "{service}", "{wildcard}"];

export const PreviewVariable = z.object({
	key: EnvKey,
	/** Write-only for secrets: omitted on read, and omitted on write to keep the stored value. */
	value: z.string().optional(),
	secret: z.boolean().default(true),
});
export type PreviewVariable = z.infer<typeof PreviewVariable>;

/** A project's opt-in pull request previews. */
export const PreviewSettings = z
	.object({
		enabled: z.boolean(),
		/** The environment each preview is cloned from. */
		sourceEnvironmentId: z.string().min(1),
		/** Slugs of the source environment's git services that build the pull request's head commit. */
		services: z.array(z.string().min(1)).default([]),
		/**
		 * Names of the source environment's git stacks that read their compose file, and build, from the
		 * pull request's head. The other stacks are copied as they are.
		 */
		stacks: z.array(z.string().min(1)).default([]),
		/**
		 * e.g. `pr-{number}.{wildcard}` or `pr-{number}-{service}.preview.example.com`. Null gives each
		 * service a generated hostname. A service whose host another one already took also gets a generated one.
		 */
		domainPattern: z
			.string()
			.trim()
			.toLowerCase()
			.max(200)
			.refine((p) => p.includes("{number}"), "the pattern needs {number}")
			.nullable(),
		/** Win over every variable the source environment and its services define. */
		variables: z.array(PreviewVariable).max(200).default([]),
		maxPreviews: z.int().min(1).max(50).default(5),
		/** A preview no pull request event touched for this long is deleted. */
		ttlHours: z
			.int()
			.min(1)
			.max(24 * 90)
			.default(72),
		/** Off by default: a fork's code would run with the preview's variables and secrets. */
		allowForks: z.boolean().default(false),
	})
	.refine((s) => s.services.length + s.stacks.length > 0, {
		message: "follow at least one service or stack",
		path: ["services"],
	})
	.meta({ id: "PreviewSettings" });
export type PreviewSettings = z.infer<typeof PreviewSettings>;

/** What a managed preview environment records about its pull request. */
export const PreviewInfo = z
	.object({
		number: z.int(),
		title: z.string(),
		/** The pull request's web page, when the provider sent it. */
		url: z.string().optional(),
		headBranch: z.string(),
		headSha: z.string(),
		author: z.string(),
		/** `https://` URLs of the preview's domains. */
		urls: z.array(z.string()),
		/** Each exposed service's URL by slug, stack services included; what `LOGISTACK_PREVIEW_URL_<SERVICE>` holds. */
		serviceUrls: z.record(z.string(), z.string()).optional(),
		/** The URL of the first followed service with a domain, else the first URL; `LOGISTACK_PREVIEW_URL`. */
		primaryUrl: z.string().optional(),
		/** Why a stack of the preview could not follow the pull request's last commit, by stack name. */
		stackErrors: z.record(z.string(), z.string()).optional(),
		/** The provider comment LogiStack keeps up to date on the pull request. */
		commentId: z.string().optional(),
		expiresAt: z.iso.datetime(),
	})
	.meta({ id: "PreviewInfo" });
export type PreviewInfo = z.infer<typeof PreviewInfo>;
