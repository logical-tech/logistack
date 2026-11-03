import { describe, expect, test } from "bun:test";
import {
	type DeploymentStatus,
	deploymentStatuses,
} from "@logistack/contracts";
import {
	type DeploymentEvent,
	isTerminal,
	transition,
} from "../src/deployment.ts";

const events: Record<string, DeploymentEvent> = {
	"start(git)": { type: "start", source: "git" },
	"start(image)": { type: "start", source: "image" },
	cloned: { type: "cloned" },
	"built(push)": { type: "built", push: true },
	"built(no push)": { type: "built", push: false },
	pushed: { type: "pushed" },
	healthy: { type: "healthy" },
	fail: { type: "fail" },
	cancel: { type: "cancel" },
	supersede: { type: "supersede" },
};

// Every legal transition. Any (state, event) pair absent here must be rejected.
const legal: Record<DeploymentStatus, Record<string, DeploymentStatus>> = {
	queued: {
		"start(git)": "cloning",
		"start(image)": "deploying",
		fail: "failed",
		cancel: "cancelled",
		supersede: "superseded",
	},
	cloning: {
		cloned: "building",
		fail: "failed",
		cancel: "cancelled",
		supersede: "superseded",
	},
	building: {
		"built(push)": "pushing",
		"built(no push)": "deploying",
		fail: "failed",
		cancel: "cancelled",
		supersede: "superseded",
	},
	pushing: {
		pushed: "deploying",
		fail: "failed",
		cancel: "cancelled",
		supersede: "superseded",
	},
	deploying: { healthy: "healthy", fail: "failed" },
	healthy: {},
	failed: {},
	cancelled: {},
	superseded: {},
};

describe("deployment state machine", () => {
	for (const from of deploymentStatuses) {
		for (const [name, event] of Object.entries(events)) {
			const expected = legal[from][name];
			test(`${from} --${name}--> ${expected ?? "rejected"}`, () => {
				const result = transition(from, event);
				if (expected) {
					expect(result).toEqual({ ok: true, state: expected });
				} else {
					expect(result).toEqual({
						ok: false,
						error: { code: "illegal_transition", from, event: event.type },
					});
				}
			});
		}
	}

	test("terminal states are exactly those with no outgoing transitions", () => {
		for (const s of deploymentStatuses) {
			expect(isTerminal(s)).toBe(Object.keys(legal[s]).length === 0);
		}
	});
});
