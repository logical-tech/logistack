import type { GitRefKind, GitTrigger } from "@logistack/contracts";

/** The fields of a normalised git event the rules read (providers' `PushEvent` satisfies it). */
export type TriggerEvent = {
	ref: { kind: GitRefKind; name: string };
	commitMessage: string;
	/** Undefined when the provider did not list files: treated as "anything changed". */
	changedPaths?: string[];
};

/** A service's trigger rules: its stored `GitTrigger`, the branch it builds, and its watch paths. */
export type TriggerRules = GitTrigger & {
	branch: string;
	watchPaths: readonly string[];
};

/**
 * `ignore`: the event is not addressed to this service (another branch, a tag for a branch-push service);
 * nothing is recorded. `skip`: it is, but a rule held it back; a `skipped` deployment records the reason.
 */
export type TriggerDecision =
	| { action: "deploy"; waitForChecks: boolean }
	| { action: "skip"; reason: string }
	| { action: "ignore"; reason: string };

export const DEFAULT_GIT_TRIGGER: GitTrigger = {
	on: "branch",
	tagPattern: "*",
	waitForChecks: false,
	checksTimeoutMinutes: 30,
};

export const SKIP_MARKERS = ["[skip ci]", "[ci skip]", "[skip deploy]"];

const trim = (p: string) => p.replace(/^\/+|\/+$/g, "");

/**
 * Whether a push touching `changed` should deploy a service watching `watch`. No watch paths,
 * or a provider that could not list the files, deploys. A glob matches with Bun.Glob; a plain path
 * is a directory prefix.
 */
export function touchesWatchPaths(
	changed: string[] | undefined,
	watch: readonly string[],
): boolean {
	if (!watch.length || changed === undefined) return true;
	return changed.some((file) =>
		watch.some((w) => {
			const pattern = trim(w);
			if (/[*?[{]/.test(pattern)) return new Bun.Glob(pattern).match(file);
			return file === pattern || file.startsWith(`${pattern}/`);
		}),
	);
}

export function evaluateTrigger(
	event: TriggerEvent,
	rules: TriggerRules,
): TriggerDecision {
	const { kind, name } = event.ref;
	if (kind !== rules.on)
		return {
			action: "ignore",
			reason: `Deploys on ${rules.on} events, not ${kind} events`,
		};
	if (kind === "branch" && name !== rules.branch)
		return { action: "ignore", reason: `Tracks ${rules.branch}, not ${name}` };
	if (kind !== "branch" && !new Bun.Glob(rules.tagPattern).match(name))
		return {
			action: "skip",
			reason: `Tag ${name} does not match ${rules.tagPattern}`,
		};
	const message = event.commitMessage.toLowerCase();
	const marker = SKIP_MARKERS.find((m) => message.includes(m));
	if (marker)
		return { action: "skip", reason: `Commit message contains ${marker}` };
	// A tag or release names a commit, not a diff: watch paths narrow branch pushes only.
	if (
		kind === "branch" &&
		!touchesWatchPaths(event.changedPaths, rules.watchPaths)
	)
		return { action: "skip", reason: "No watched path changed" };
	return { action: "deploy", waitForChecks: rules.waitForChecks };
}
