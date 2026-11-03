import type { ServiceSpec } from "@logistack/contracts";
import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.ts";
import { id, timestamps } from "./columns.ts";
import {
	desiredState,
	environmentKind,
	envVarScope,
	mountKind,
	serviceKind,
} from "./enums.ts";
import { node } from "./runtime.ts";

// Depth <= 2 is enforced by the folder_depth trigger (see drizzle/0001_folder_depth.sql).
export const folder = pgTable(
	"folder",
	{
		id: id("fld"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		parentId: text("parent_id").references((): AnyPgColumn => folder.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		position: integer("position").notNull().default(0),
		...timestamps,
	},
	(t) => [
		unique("folder_slug_unique")
			.on(t.organizationId, t.parentId, t.slug)
			.nullsNotDistinct(),
		index("folder_parent_id_idx").on(t.parentId),
	],
);

export const project = pgTable(
	"project",
	{
		id: id("prj"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		folderId: text("folder_id").references(() => folder.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		...timestamps,
	},
	(t) => [
		unique("project_slug_unique").on(t.organizationId, t.slug),
		index("project_folder_id_idx").on(t.folderId),
	],
);

export const environment = pgTable(
	"environment",
	{
		id: id("env"),
		projectId: text("project_id")
			.notNull()
			.references(() => project.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		kind: environmentKind("kind").notNull(),
		isDefault: boolean("is_default").notNull().default(false),
		...timestamps,
	},
	(t) => [
		unique("environment_slug_unique").on(t.projectId, t.slug),
		uniqueIndex("environment_one_default_idx")
			.on(t.projectId)
			.where(sql`${t.isDefault}`),
	],
);

export const service = pgTable(
	"service",
	{
		id: id("svc"),
		environmentId: text("environment_id")
			.notNull()
			.references(() => environment.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		kind: serviceKind("kind").notNull(),
		nodeId: text("node_id").references(() => node.id, { onDelete: "set null" }),
		spec: jsonb("spec").$type<ServiceSpec>().notNull(),
		desiredState: desiredState("desired_state").notNull().default("running"),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		/** Provenance of an imported service, e.g. `dokploy:<appName>/<service>`; re-imports match on it. */
		importedFrom: text("imported_from"),
		...timestamps,
	},
	(t) => [
		unique("service_slug_unique").on(t.environmentId, t.slug),
		index("service_node_id_idx").on(t.nodeId),
		check("service_spec_kind_check", sql`${t.spec}->>'kind' = ${t.kind}::text`),
	],
);

export const envVar = pgTable(
	"env_var",
	{
		id: id("var"),
		scope: envVarScope("scope").notNull(),
		// Polymorphic: organization, project, environment or service id depending on `scope`.
		scopeId: text("scope_id").notNull(),
		key: text("key").notNull(),
		valueEncrypted: text("value_encrypted").notNull(),
		isSecret: boolean("is_secret").notNull().default(false),
		isBuildTime: boolean("is_build_time").notNull().default(false),
		...timestamps,
	},
	(t) => [unique("env_var_key_unique").on(t.scope, t.scopeId, t.key)],
);

export const mount = pgTable(
	"mount",
	{
		id: id("mnt"),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		kind: mountKind("kind").notNull(),
		target: text("target").notNull(),
		volumeName: text("volume_name"),
		contentEncrypted: text("content_encrypted"),
		readOnly: boolean("read_only").notNull().default(false),
		...timestamps,
	},
	(t) => [
		unique("mount_target_unique").on(t.serviceId, t.target),
		check(
			"mount_kind_payload_check",
			sql`(${t.kind} = 'volume' and ${t.volumeName} is not null) or (${t.kind} <> 'volume' and ${t.contentEncrypted} is not null)`,
		),
	],
);
