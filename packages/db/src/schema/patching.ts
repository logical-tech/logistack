import type {
	PackageManager,
	PackageUpdate,
	PatchReboot,
	PatchRunNode,
	PatchRunState,
} from "@logistack/contracts";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";
import { node } from "./runtime.ts";

/** The last scan of a node's host packages, written by the worker. */
export const nodePatchStatus = pgTable("node_patch_status", {
	nodeId: text("node_id")
		.primaryKey()
		.references(() => node.id, { onDelete: "cascade" }),
	packageManager: text("package_manager").$type<PackageManager>(),
	os: text("os"),
	kernel: text("kernel"),
	rebootRequired: boolean("reboot_required").notNull().default(false),
	updates: jsonb("updates").$type<PackageUpdate[]>().notNull().default([]),
	securityCount: integer("security_count").notNull().default(0),
	scannedAt: tstz("scanned_at"),
	error: text("error"),
	...timestamps,
});

/** One patch run over one or more nodes, one at a time; advanced by the worker, resumable. */
export const patchRun = pgTable(
	"patch_run",
	{
		id: id("pat"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		state: text("state").$type<PatchRunState>().notNull().default("queued"),
		trigger: text("trigger").$type<"manual" | "window">().notNull(),
		securityOnly: boolean("security_only").notNull().default(false),
		reboot: text("reboot").$type<PatchReboot>().notNull().default("if_needed"),
		nodes: jsonb("nodes").$type<PatchRunNode[]>().notNull(),
		log: jsonb("log").$type<string[]>().notNull().default([]),
		error: text("error"),
		cancelRequested: boolean("cancel_requested").notNull().default(false),
		createdBy: text("created_by"),
		claimedAt: tstz("claimed_at"),
		finishedAt: tstz("finished_at"),
		...timestamps,
	},
	(t) => [index("patch_run_org_created_idx").on(t.organizationId, t.createdAt)],
);

/** An organization's patch window; the worker keeps a BullMQ Job Scheduler in step with it. */
export const patchPolicy = pgTable("patch_policy", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	enabled: boolean("enabled").notNull().default(false),
	cron: text("cron").notNull().default("0 4 * * 0"),
	timezone: text("timezone").notNull().default("UTC"),
	securityOnly: boolean("security_only").notNull().default(true),
	reboot: text("reboot").$type<PatchReboot>().notNull().default("if_needed"),
	...timestamps,
});
