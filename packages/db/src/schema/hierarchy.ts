import type {
	EnvironmentColor,
	PreviewInfo,
	ServiceIcon,
	ServiceSpec,
	StackGitSource,
} from "@logistack/contracts";
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
import { id, timestamps, tstz } from "./columns.ts";
import {
	desiredState,
	environmentKind,
	envVarScope,
	mountKind,
	serviceKind,
	stackSource,
} from "./enums.ts";
import { node } from "./runtime.ts";
import { secret } from "./secrets.ts";

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
		/** Set while archived: its services are stopped and deploys are refused. */
		archivedAt: tstz("archived_at"),
		/** `PreviewSettings` as JSON, encrypted: its variables may be secrets. Null until previews are set up. */
		previewSettingsEncrypted: text("preview_settings_encrypted"),
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
		color: text("color").$type<EnvironmentColor>(),
		/** Set on the preview environments LogiStack creates for pull requests, which it alone updates and deletes. */
		preview: jsonb("preview").$type<PreviewInfo>(),
		...timestamps,
	},
	(t) => [
		unique("environment_slug_unique").on(t.projectId, t.slug),
		uniqueIndex("environment_one_default_idx")
			.on(t.projectId)
			.where(sql`${t.isDefault}`),
	],
);

/**
 * Services created together from one template or compose file. Deleting a stack deletes its
 * services; the reconciler then removes their Docker objects.
 */
export const stack = pgTable(
	"stack",
	{
		id: id("stk"),
		environmentId: text("environment_id")
			.notNull()
			.references(() => environment.id, { onDelete: "cascade" }),
		/** The instance name; also the provenance key of its services. */
		name: text("name").notNull(),
		source: stackSource("source").notNull(),
		/** Catalog template id when `source` is template. */
		templateId: text("template_id"),
		/** The compose file last applied, encrypted (it may hold credentials), when `source` is compose or git. */
		composeYamlEncrypted: text("compose_yaml_encrypted"),
		/** Where the compose file lives when `source` is git. */
		git: jsonb("git").$type<StackGitSource>(),
		/** Why the last push could not be applied; cleared by the next git update that applies. */
		gitSyncError: jsonb("git_sync_error").$type<{
			at: string;
			commitSha: string | null;
			message: string;
			details: string[];
		}>(),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		...timestamps,
	},
	(t) => [unique("stack_name_unique").on(t.environmentId, t.name)],
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
		/** Stopped by archiving its project; unarchiving starts exactly these again. */
		stoppedByArchive: boolean("stopped_by_archive").notNull().default(false),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		/** Provenance of an imported service, e.g. `dokploy:<appName>/<service>`; re-imports match on it. */
		importedFrom: text("imported_from"),
		/** A brand icon slug (`postgresql`, `nginx`, …); null falls back to the engine or image icon, then the kind's. */
		icon: text("icon").$type<ServiceIcon>(),
		stackId: text("stack_id").references((): AnyPgColumn => stack.id, {
			onDelete: "cascade",
		}),
		...timestamps,
	},
	(t) => [
		unique("service_slug_unique").on(t.environmentId, t.slug),
		index("service_stack_id_idx").on(t.stackId),
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
		/**
		 * Set on a service variable that references a managed secret; the value comes from the
		 * secret at deploy time. `value_encrypted` then holds a v1 copy for the previous release
		 * and for in-process readers (database, storage and game credentials).
		 */
		secretId: text("secret_id").references(() => secret.id, {
			onDelete: "restrict",
		}),
		/** A secret reference mounted as `/run/secrets/<key>` (a Swarm secret) instead of an env var. */
		asFile: boolean("as_file").notNull().default(false),
		...timestamps,
	},
	(t) => [
		unique("env_var_key_unique").on(t.scope, t.scopeId, t.key),
		index("env_var_secret_id_idx").on(t.secretId),
	],
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

/**
 * A Docker volume another platform created (e.g. Dokploy), mounted in place instead of copied.
 * It carries none of our labels, so no cleanup ever lists it; this row is what marks it ours to mount.
 * `ownerId` is what would otherwise name the volume: a volume mount's id, or a database or storage
 * service's id for its data directory.
 */
export const adoptedVolume = pgTable("adopted_volume", {
	volumeName: text("volume_name").primaryKey(),
	ownerId: text("owner_id").notNull().unique(),
	serviceId: text("service_id")
		.notNull()
		.references(() => service.id, { onDelete: "cascade" }),
	/** e.g. `dokploy`. */
	source: text("source").notNull(),
	...timestamps,
});

/** HTTP basic auth the proxy puts in front of every domain of a service; bcrypt hashes only. */
export const serviceBasicAuth = pgTable("service_basic_auth", {
	serviceId: text("service_id")
		.primaryKey()
		.references(() => service.id, { onDelete: "cascade" }),
	users: jsonb("users").$type<{ username: string; hash: string }[]>().notNull(),
	...timestamps,
});
