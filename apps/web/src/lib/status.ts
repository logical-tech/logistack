import type { DeploymentStatus, NodeStatus, ObservedStatus } from "./api/types";

/** Colour roles from the token sheet. One tone means one thing everywhere. */
export type Tone = "ok" | "busy" | "info" | "warn" | "bad" | "idle";

export type StatusMeta = {
	label: string;
	tone: Tone;
	/** In-flight states pulse; settled states stay still. */
	live?: boolean;
};

export const SERVICE_STATUS: Record<ObservedStatus, StatusMeta> = {
	running: { label: "Running", tone: "ok" },
	starting: { label: "Starting", tone: "busy", live: true },
	unhealthy: { label: "Unhealthy", tone: "warn" },
	stopped: { label: "Stopped", tone: "idle" },
	failed: { label: "Failed", tone: "bad" },
	unknown: { label: "Unknown", tone: "idle" },
};

export const DEPLOYMENT_STATUS: Record<DeploymentStatus, StatusMeta> = {
	awaiting_checks: { label: "Waiting for checks", tone: "idle", live: true },
	queued: { label: "Queued", tone: "idle", live: true },
	cloning: { label: "Cloning", tone: "busy", live: true },
	building: { label: "Building", tone: "busy", live: true },
	pushing: { label: "Pushing", tone: "busy", live: true },
	releasing: { label: "Releasing", tone: "busy", live: true },
	deploying: { label: "Deploying", tone: "info", live: true },
	healthy: { label: "Ready", tone: "ok" },
	failed: { label: "Failed", tone: "bad" },
	cancelled: { label: "Cancelled", tone: "idle" },
	superseded: { label: "Superseded", tone: "idle" },
	skipped: { label: "Skipped", tone: "idle" },
};

/** Pending until the worker's proxy sync lands; error when Caddy or the route refused. */
export const DOMAIN_STATUS: Record<"pending" | "active" | "error", StatusMeta> =
	{
		pending: { label: "Pending", tone: "busy", live: true },
		active: { label: "Active", tone: "ok" },
		error: { label: "Error", tone: "bad" },
	};

export const NODE_STATUS: Record<NodeStatus, StatusMeta> = {
	ready: { label: "Ready", tone: "ok" },
	pending: { label: "Joining", tone: "busy", live: true },
	draining: { label: "Draining", tone: "warn" },
	down: { label: "Down", tone: "bad" },
};

/** `pending` waits on a person (install the GitHub App), so it reads as attention, not progress. */
export const GIT_PROVIDER_STATUS: Record<
	"connected" | "pending" | "error",
	StatusMeta
> = {
	connected: { label: "Connected", tone: "ok" },
	pending: { label: "Setup pending", tone: "warn" },
	error: { label: "Unreachable", tone: "bad" },
};

/** Backup, verify, restore and schedule runs. `skipped` and `cancelled` were concurrency's doing, not failures. */
export const RUN_STATUS: Record<
	"running" | "succeeded" | "failed" | "skipped" | "cancelled",
	StatusMeta
> = {
	running: { label: "Running", tone: "busy", live: true },
	succeeded: { label: "Succeeded", tone: "ok" },
	failed: { label: "Failed", tone: "bad" },
	skipped: { label: "Skipped", tone: "idle" },
	cancelled: { label: "Cancelled", tone: "idle" },
};

/** An in-app update run as a whole, and each of its steps. */
export const UPDATE_STATUS: Record<
	"queued" | "running" | "succeeded" | "failed",
	StatusMeta
> = {
	queued: { label: "Starting", tone: "idle", live: true },
	running: { label: "Updating", tone: "info", live: true },
	succeeded: { label: "Updated", tone: "ok" },
	failed: { label: "Failed", tone: "bad" },
};

export const UPDATE_STEP_STATUS: Record<
	"pending" | "running" | "done" | "failed" | "rolled_back",
	StatusMeta
> = {
	pending: { label: "Waiting", tone: "idle" },
	running: { label: "In progress", tone: "info", live: true },
	done: { label: "Done", tone: "ok" },
	failed: { label: "Failed", tone: "bad" },
	rolled_back: { label: "Rolled back", tone: "warn" },
};

/**
 * A migration item. `moving` is the client's own state between asking for an import or cutover
 * and the event that settles it; the server stores only settled states.
 */
/** Labels name the platform the items come from (Dokploy or Coolify). */
export const migrationItemStatus = (
	source: string,
): Record<
	| "planned"
	| "imported"
	| "cut_over"
	| "failed"
	| "rolled_back"
	| "skipped"
	| "moving",
	StatusMeta
> => ({
	planned: { label: "Planned", tone: "idle" },
	moving: { label: "In progress", tone: "info", live: true },
	imported: { label: "Ready to move", tone: "idle" },
	cut_over: { label: "On LogiStack", tone: "ok" },
	failed: { label: "Failed", tone: "bad" },
	rolled_back: { label: `Back on ${source}`, tone: "warn" },
	skipped: { label: `Stays on ${source}`, tone: "idle" },
});

/** What the inventory found the item can carry over. */
export const MIGRATION_SUPPORT: Record<
	"full" | "partial" | "unsupported",
	StatusMeta
> = {
	full: { label: "Full", tone: "ok" },
	partial: { label: "Partial", tone: "warn" },
	unsupported: { label: "Not supported", tone: "bad" },
};

/** Worst first: a project reads as its most urgent service. */
const SEVERITY: ObservedStatus[] = [
	"failed",
	"unhealthy",
	"starting",
	"running",
	"unknown",
	"stopped",
];

export type ProjectHealth =
	| { kind: "empty" }
	| { kind: "status"; status: ObservedStatus; running: number; total: number };

export function projectHealth(statuses: ObservedStatus[]): ProjectHealth {
	if (statuses.length === 0) return { kind: "empty" };
	const present = new Set(statuses);
	const status = SEVERITY.find((s) => present.has(s)) ?? "unknown";
	const running = statuses.filter((s) => s === "running").length;
	return { kind: "status", status, running, total: statuses.length };
}

/** Sort key so lists and strips read worst-first. */
export const severityRank = (s: ObservedStatus) => SEVERITY.indexOf(s);

/** A patch run as a whole. */
export const PATCH_RUN_STATUS: Record<
	"queued" | "running" | "succeeded" | "failed" | "cancelled",
	StatusMeta
> = {
	queued: { label: "Queued", tone: "idle", live: true },
	running: { label: "Patching", tone: "info", live: true },
	succeeded: { label: "Patched", tone: "ok" },
	failed: { label: "Failed", tone: "bad" },
	cancelled: { label: "Cancelled", tone: "idle" },
};

/** One node of a patch run. */
export const PATCH_NODE_STATUS: Record<
	"pending" | "running" | "succeeded" | "failed" | "skipped",
	StatusMeta
> = {
	pending: { label: "Waiting", tone: "idle" },
	running: { label: "In progress", tone: "info", live: true },
	succeeded: { label: "Patched", tone: "ok" },
	failed: { label: "Failed", tone: "bad" },
	skipped: { label: "Skipped", tone: "idle" },
};

export const TONE_DOT: Record<Tone, string> = {
	ok: "bg-ok",
	busy: "bg-busy",
	info: "bg-info",
	warn: "bg-warn",
	bad: "bg-bad",
	idle: "bg-idle",
};

export const TONE_TEXT: Record<Tone, string> = {
	ok: "text-ok-text",
	busy: "text-busy-text",
	info: "text-info-text",
	warn: "text-warn-text",
	bad: "text-bad-text",
	idle: "text-idle-text",
};

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

/** Vulnerability severity; only critical and high take a status colour. */
export const VULN_SEVERITY: Record<Severity, StatusMeta> = {
	critical: { label: "Critical", tone: "bad" },
	high: { label: "High", tone: "warn" },
	medium: { label: "Medium", tone: "idle" },
	low: { label: "Low", tone: "idle" },
	unknown: { label: "Unknown", tone: "idle" },
};

/** The last GitOps sync of a project (`project_gitops.last_status`). */
export const GITOPS_STATUS: Record<
	"applied" | "unchanged" | "planned" | "failed",
	StatusMeta
> = {
	applied: { label: "Applied", tone: "ok" },
	unchanged: { label: "In sync", tone: "ok" },
	planned: { label: "Changes waiting", tone: "warn" },
	failed: { label: "Sync failed", tone: "bad" },
};
