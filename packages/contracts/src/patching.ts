import { z } from "zod";

/** The host package managers node patching drives. */
export const PackageManager = z.enum(["apt", "dnf"]);
export type PackageManager = z.infer<typeof PackageManager>;

export const PackageUpdate = z.object({
	name: z.string(),
	/** Installed version; null when the update pulls in a new package (a new kernel, say). */
	from: z.string().nullable(),
	to: z.string(),
	/** Comes from a security repository (apt) or a security advisory (dnf). */
	security: z.boolean(),
});
export type PackageUpdate = z.infer<typeof PackageUpdate>;

/** What the last scan of a node's host found. */
export const NodePatchStatus = z.object({
	nodeId: z.string(),
	packageManager: PackageManager.nullable(),
	os: z.string().nullable(),
	/** Running kernel (`uname -r`). */
	kernel: z.string().nullable(),
	rebootRequired: z.boolean(),
	updates: z.array(PackageUpdate),
	securityCount: z.int().nonnegative(),
	scannedAt: z.coerce.date().nullable(),
	/** The last scan failed; `updates` is from the scan before it. */
	error: z.string().nullable(),
});
export type NodePatchStatus = z.infer<typeof NodePatchStatus>;

/** A node's walk through a patch run, in order. */
export const patchSteps = [
	"scan",
	"drain",
	"upgrade",
	"reboot",
	"rejoin",
	"healthy",
	"undrain",
] as const;
export const PatchStep = z.enum(patchSteps);
export type PatchStep = z.infer<typeof PatchStep>;

export const PatchReboot = z.enum(["if_needed", "never"]);
export type PatchReboot = z.infer<typeof PatchReboot>;

export const PatchNodeState = z.enum([
	"pending",
	"running",
	"succeeded",
	"failed",
	"skipped",
]);
export type PatchNodeState = z.infer<typeof PatchNodeState>;

export const PatchRunNode = z.object({
	nodeId: z.string(),
	hostname: z.string(),
	state: PatchNodeState,
	/** The step running, or the one that failed. */
	step: PatchStep.nullable(),
	error: z.string().nullable(),
	/** Packages the upgrade changed. */
	upgraded: z.int().nonnegative(),
	rebooted: z.boolean(),
	/** The node was already drained before the run, so the run leaves it drained. */
	wasDrained: z.boolean(),
	/** Boot identity before the reboot; a different one afterwards proves the host came back. */
	bootId: z.string().nullable(),
	rebootAt: z.coerce.date().nullable(),
	startedAt: z.coerce.date().nullable(),
	finishedAt: z.coerce.date().nullable(),
});
export type PatchRunNode = z.infer<typeof PatchRunNode>;

export const PatchRunState = z.enum([
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
]);
export type PatchRunState = z.infer<typeof PatchRunState>;

export const PatchRun = z.object({
	id: z.string(),
	state: PatchRunState,
	trigger: z.enum(["manual", "window"]),
	securityOnly: z.boolean(),
	reboot: PatchReboot,
	/** Patched one at a time, in this order. */
	nodes: z.array(PatchRunNode),
	log: z.array(z.string()),
	error: z.string().nullable(),
	createdAt: z.coerce.date(),
	finishedAt: z.coerce.date().nullable(),
});
export type PatchRun = z.infer<typeof PatchRun>;

export const PatchRunInput = z.object({
	/** One node patches it alone; several patch one at a time in this order. */
	nodeIds: z.array(z.string()).min(1).max(100),
	/** Only packages with a security update. */
	securityOnly: z.boolean().default(false),
	reboot: PatchReboot.default("if_needed"),
});
export type PatchRunInput = z.infer<typeof PatchRunInput>;

/** An organization's patch window: a rolling run over every node on a cron. */
export const PatchPolicy = z.object({
	enabled: z.boolean(),
	cron: z.string().min(9).max(100),
	timezone: z.string().min(1).max(64),
	securityOnly: z.boolean(),
	reboot: PatchReboot,
});
export type PatchPolicy = z.infer<typeof PatchPolicy>;

export const PATCH_POLICY_DEFAULT: PatchPolicy = {
	enabled: false,
	cron: "0 4 * * 0",
	timezone: "UTC",
	securityOnly: true,
	reboot: "if_needed",
};

/** Maintenance-queue scheduler id of an organization's patch window. */
export const patchWindowSchedulerId = (organizationId: string) =>
	`patch-window:${organizationId}`;
