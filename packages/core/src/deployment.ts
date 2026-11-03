import type { DeploymentStatus } from "@logistack/contracts";

export type DeploymentEvent =
	| { type: "start"; source: "git" | "image" }
	| { type: "cloned" }
	| { type: "built"; push: boolean }
	| { type: "pushed" }
	| { type: "healthy" }
	| { type: "fail" }
	| { type: "cancel" }
	| { type: "supersede" };

export type TransitionResult =
	| { ok: true; state: DeploymentStatus }
	| {
			ok: false;
			error: {
				code: "illegal_transition";
				from: DeploymentStatus;
				event: DeploymentEvent["type"];
			};
	  };

type Handler = (event: DeploymentEvent) => DeploymentStatus | undefined;

// Once a rollout reaches Swarm (`deploying`) it can only end healthy or failed: Swarm owns rollback.
const abortable: Partial<Record<DeploymentEvent["type"], DeploymentStatus>> = {
	fail: "failed",
	cancel: "cancelled",
	supersede: "superseded",
};

const table: Record<DeploymentStatus, Handler> = {
	queued: (e) =>
		e.type === "start"
			? e.source === "git"
				? "cloning"
				: "deploying"
			: abortable[e.type],
	cloning: (e) => (e.type === "cloned" ? "building" : abortable[e.type]),
	building: (e) =>
		e.type === "built" ? (e.push ? "pushing" : "deploying") : abortable[e.type],
	pushing: (e) => (e.type === "pushed" ? "deploying" : abortable[e.type]),
	deploying: (e) =>
		e.type === "healthy" ? "healthy" : e.type === "fail" ? "failed" : undefined,
	healthy: () => undefined,
	failed: () => undefined,
	cancelled: () => undefined,
	superseded: () => undefined,
};

export function transition(
	from: DeploymentStatus,
	event: DeploymentEvent,
): TransitionResult {
	const state = table[from](event);
	return state
		? { ok: true, state }
		: {
				ok: false,
				error: { code: "illegal_transition", from, event: event.type },
			};
}

export function isTerminal(state: DeploymentStatus): boolean {
	return (
		state === "healthy" ||
		state === "failed" ||
		state === "cancelled" ||
		state === "superseded"
	);
}
