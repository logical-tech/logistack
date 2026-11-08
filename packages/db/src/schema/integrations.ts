import { sql } from "drizzle-orm";
import {
	boolean,
	jsonb,
	pgTable,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { id, timestamps } from "./columns.ts";
import { gitProviderKind, registryKind } from "./enums.ts";
import { service } from "./hierarchy.ts";
import { node } from "./runtime.ts";

const org = () =>
	text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" });

export const gitProvider = pgTable("git_provider", {
	id: id("git"),
	organizationId: org(),
	kind: gitProviderKind("kind").notNull(),
	name: text("name").notNull(),
	// Encrypted JSON document (v1:<iv>:<ct>), not jsonb: the whole config is secret.
	configEncrypted: text("config_encrypted").notNull(),
	...timestamps,
});

export const registry = pgTable(
	"registry",
	{
		id: id("reg"),
		organizationId: org(),
		kind: registryKind("kind").notNull(),
		url: text("url").notNull(),
		username: text("username"),
		passwordEncrypted: text("password_encrypted"),
		isDefault: boolean("is_default").notNull().default(false),
		...timestamps,
	},
	(t) => [
		uniqueIndex("registry_one_default_idx")
			.on(t.organizationId)
			.where(sql`${t.isDefault}`),
	],
);

export const sshKey = pgTable(
	"ssh_key",
	{
		id: id("ssh"),
		organizationId: org(),
		name: text("name").notNull(),
		publicKey: text("public_key").notNull(),
		privateKeyEncrypted: text("private_key_encrypted").notNull(),
		fingerprint: text("fingerprint").notNull(),
		...timestamps,
	},
	(t) => [
		unique("ssh_key_fingerprint_unique").on(t.organizationId, t.fingerprint),
	],
);

export const s3Destination = pgTable("s3_destination", {
	id: id("s3d"),
	organizationId: org(),
	name: text("name").notNull(),
	endpoint: text("endpoint").notNull(),
	region: text("region").notNull(),
	bucket: text("bucket").notNull(),
	prefix: text("prefix").notNull().default(""),
	accessKeyId: text("access_key_id").notNull(),
	secretEncrypted: text("secret_encrypted").notNull(),
	forcePathStyle: boolean("force_path_style").notNull().default(false),
	/** Set when the destination is a LogiStack storage service; the worker derives its endpoint. */
	storageServiceId: text("storage_service_id").references(() => service.id, {
		onDelete: "set null",
	}),
	/**
	 * `s3` uses the S3 columns above. Any other kind (sftp, webdav, azureblob, drive, b2, local)
	 * keeps its clear settings in `config` and an encrypted JSON of its secrets in
	 * `secret_encrypted`; its S3 columns hold empty strings.
	 */
	kind: text("kind").notNull().default("s3"),
	config: jsonb("config")
		.$type<Record<string, unknown>>()
		.notNull()
		.default({}),
	/** `local`: the node whose folder holds the backups. */
	nodeId: text("node_id").references(() => node.id, { onDelete: "set null" }),
	...timestamps,
});
