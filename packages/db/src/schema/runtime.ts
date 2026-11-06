import type { BuildPlatform, NodeDesired } from "@logistack/contracts";
import {
	type AnyPgColumn,
	index,
	integer,
	jsonb,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";
import {
	deploymentStatus,
	deploymentTrigger,
	nodeRole,
	nodeStatus,
	observedState,
} from "./enums.ts";
import { service } from "./hierarchy.ts";

export type NodeFacts = {
	cpus?: number;
	memoryBytes?: number;
	engineVersion?: string;
	leader?: boolean;
	/** As the engine reports it: `x86_64`, `aarch64`. */
	architecture?: string;
};

export const node = pgTable("node", {
	id: id("nod"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	swarmNodeId: text("swarm_node_id").notNull().unique(),
	hostname: text("hostname").notNull(),
	address: text("address").notNull(),
	role: nodeRole("role").notNull(),
	labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
	status: nodeStatus("status").notNull().default("pending"),
	/** Desired Swarm availability; `remove` drains, leaves and deletes the node. */
	desired: text("desired").$type<NodeDesired>().notNull().default("active"),
	/** Latest Swarm inspect facts (cpus, memoryBytes, engineVersion, leader). */
	facts: jsonb("facts").$type<NodeFacts>().notNull().default({}),
	agentVersion: text("agent_version"),
	lastSeenAt: tstz("last_seen_at"),
	...timestamps,
});

// Status changes go through `transition()` in @logistack/core.
export const deployment = pgTable(
	"deployment",
	{
		id: id("dep"),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		status: deploymentStatus("status").notNull().default("queued"),
		trigger: deploymentTrigger("trigger").notNull(),
		commitSha: text("commit_sha"),
		commitMessage: text("commit_message"),
		/** The tag to clone for a tag or release trigger; null clones the source branch. */
		gitRef: text("git_ref"),
		imageRef: text("image_ref"),
		/** Platforms the image was built for (`linux/amd64`, ...); null when unknown (image sources, older builds). */
		platforms: text("platforms").array().$type<BuildPlatform[]>(),
		/** Encrypted `SpecSnapshot` JSON of what the deploy applied; the pending diff's baseline. */
		specSnapshotEncrypted: text("spec_snapshot_encrypted"),
		startedAt: tstz("started_at"),
		finishedAt: tstz("finished_at"),
		error: text("error"),
		/** Why the deployment is awaiting checks, or why it was skipped (skip marker, watch paths, tag pattern, checks). */
		reason: text("reason"),
		logPath: text("log_path"),
		supersededBy: text("superseded_by").references(
			(): AnyPgColumn => deployment.id,
			{ onDelete: "set null" },
		),
		...timestamps,
	},
	(t) => [
		index("deployment_service_created_idx").on(t.serviceId, t.createdAt.desc()),
	],
);

// Written by the reconciler and agent events only.
export const serviceStatus = pgTable("service_status", {
	serviceId: text("service_id")
		.primaryKey()
		.references(() => service.id, { onDelete: "cascade" }),
	observed: observedState("observed").notNull().default("unknown"),
	replicasRunning: integer("replicas_running").notNull().default(0),
	replicasDesired: integer("replicas_desired").notNull().default(0),
	tasks: jsonb("tasks")
		.$type<Record<string, unknown>[]>()
		.notNull()
		.default([]),
	observedAt: tstz("observed_at").notNull().defaultNow(),
	...timestamps,
});
