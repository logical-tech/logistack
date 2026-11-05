/**
 * Reads a Coolify (stable v4) database into a `CoolifySnapshot`. Read-only: SELECTs inside a READ
 * ONLY transaction. Every required column is checked against `information_schema` first, so a
 * release with another schema is refused with the missing columns named; columns and tables
 * Coolify added after 4.0.0 are optional and read as null or empty. Secrets are decrypted with the
 * APP_KEY on the way out (`decrypt.ts`); a value no key opens is named, never kept.
 */

import { type LaravelKey, laravelKey, openCoolify } from "./decrypt.ts";
import {
	type CoolifyEngine,
	CoolifySnapshot,
	coolifyEngines,
} from "./snapshot.ts";

/** A field reads a column; `?` marks one added after 4.0.0, `null` a field the table lacks. */
type Fields = Record<string, string | null>;
type Query = {
	key: keyof CoolifySnapshot;
	table: string;
	fields: Fields;
	/** Literal fields (`'postgres' as "engine"`). */
	constants?: Record<string, string>;
	/** Added after 4.0.0: read as empty when missing. */
	optionalTable?: boolean;
	/** Fields Coolify encrypts; `serialized` for `encrypt()` (env values) rather than a cast. */
	encrypted?: Record<string, { serialized?: boolean }>;
	/** The field that names a row in `undecryptable`. */
	label?: string;
	/** Skip soft-deleted rows when the table has `deleted_at`. */
	softDelete?: boolean;
};

const opt = (column: string) => `${column}?`;
const same = (...columns: string[]): Fields =>
	Object.fromEntries(columns.map((c) => [c.replace(/\?$/, ""), c]));

const databaseTables: Record<
	CoolifyEngine,
	{
		table: string;
		user: string | null;
		password: string | null;
		database: string | null;
		root: string | null;
		conf: string | null;
	}
> = {
	postgres: {
		table: "standalone_postgresqls",
		user: "postgres_user",
		password: "postgres_password",
		database: "postgres_db",
		root: null,
		conf: "postgres_conf",
	},
	mysql: {
		table: "standalone_mysqls",
		user: "mysql_user",
		password: "mysql_password",
		database: "mysql_database",
		root: "mysql_root_password",
		conf: "mysql_conf",
	},
	mariadb: {
		table: "standalone_mariadbs",
		user: "mariadb_user",
		password: "mariadb_password",
		database: "mariadb_database",
		root: "mariadb_root_password",
		conf: "mariadb_conf",
	},
	mongo: {
		table: "standalone_mongodbs",
		user: "mongo_initdb_root_username",
		password: "mongo_initdb_root_password",
		database: "mongo_initdb_database",
		root: null,
		conf: "mongo_conf",
	},
	// Redis keeps its password in env rows since 2024-10.
	redis: {
		table: "standalone_redis",
		user: null,
		password: null,
		database: null,
		root: null,
		conf: "redis_conf",
	},
	keydb: {
		table: "standalone_keydbs",
		user: null,
		password: "keydb_password",
		database: null,
		root: null,
		conf: "keydb_conf",
	},
	dragonfly: {
		table: "standalone_dragonflies",
		user: null,
		password: "dragonfly_password",
		database: null,
		root: null,
		conf: null,
	},
	clickhouse: {
		table: "standalone_clickhouses",
		user: "clickhouse_admin_user",
		password: "clickhouse_admin_password",
		database: "clickhouse_db",
		root: null,
		conf: null,
	},
};

const notificationEvents = [
	"deployment_success",
	"deployment_failure",
	"backup_success",
	"backup_failure",
	"server_disk_usage",
	"status_change",
	"scheduled_task_success",
	"scheduled_task_failure",
	"docker_cleanup_success",
	"docker_cleanup_failure",
	"server_unreachable",
] as const;

const notificationColumns: Record<string, Fields> = {
	discord: { enabled: "discord_enabled", webhook_url: "discord_webhook_url" },
	slack: { enabled: "slack_enabled", webhook_url: "slack_webhook_url" },
	telegram: {
		enabled: "telegram_enabled",
		telegram_token: "telegram_token",
		telegram_chat_id: "telegram_chat_id",
	},
	email: same(
		"smtp_enabled",
		"smtp_host",
		"smtp_port",
		"smtp_encryption",
		"smtp_username",
		"smtp_password",
		"smtp_from_address",
		"smtp_recipients",
		"resend_enabled",
		"resend_api_key",
		"use_instance_email_settings",
	),
	pushover: {
		enabled: "pushover_enabled",
		pushover_user_key: "pushover_user_key",
		pushover_api_token: "pushover_api_token",
	},
	webhook: { enabled: "webhook_enabled", webhook_url: "webhook_url" },
};
const notificationFields = [
	"enabled",
	"webhook_url",
	"telegram_token",
	"telegram_chat_id",
	...Object.keys(notificationColumns.email as Fields),
	"pushover_user_key",
	"pushover_api_token",
];

/** Every query, built only from the constant lists above: no outside input reaches SQL. */
function queries(): Query[] {
	return [
		{
			key: "servers",
			table: "servers",
			fields: same("id", "name"),
			softDelete: true,
		},
		{
			key: "destinations",
			table: "standalone_dockers",
			fields: same("id", "server_id", "network"),
		},
		{ key: "teams", table: "teams", fields: same("id", "name") },
		{
			key: "projects",
			table: "projects",
			fields: same("id", "uuid", "name", "team_id"),
		},
		{
			key: "environments",
			table: "environments",
			fields: same("id", "uuid", "name", "project_id"),
		},
		{
			key: "applications",
			table: "applications",
			softDelete: true,
			label: "name",
			fields: same(
				"id",
				"uuid",
				"name",
				"environment_id",
				"destination_type",
				"destination_id",
				"fqdn",
				"git_repository",
				"git_branch",
				"git_commit_sha",
				"docker_registry_image_name",
				"docker_registry_image_tag",
				"build_pack",
				"static_image",
				"install_command",
				"build_command",
				"start_command",
				"ports_exposes",
				"ports_mappings",
				"base_directory",
				"publish_directory",
				"dockerfile",
				"dockerfile_location",
				"dockerfile_target_build",
				"docker_compose_location",
				"docker_compose_raw",
				"docker_compose_domains",
				"source_type",
				"source_id",
				"private_key_id",
				"custom_labels",
				"custom_docker_run_options",
				"health_check_enabled",
				"health_check_path",
				"health_check_port",
				"limits_memory",
				"limits_cpus",
				"status",
				"pre_deployment_command",
				"post_deployment_command",
				"is_http_basic_auth_enabled",
				"http_basic_auth_username",
				"http_basic_auth_password",
				opt("domain_port_overrides"),
			),
			encrypted: { http_basic_auth_password: {} },
		},
		{
			key: "applicationSettings",
			table: "application_settings",
			fields: same(
				"application_id",
				"is_static",
				"is_spa",
				"is_preview_deployments_enabled",
				"is_consistent_container_name_enabled",
				"custom_internal_name",
				"connect_to_docker_network",
				"is_raw_compose_deployment_enabled",
				"is_build_server_enabled",
				"is_gpu_enabled",
			),
		},
		{
			key: "services",
			table: "services",
			softDelete: true,
			fields: same(
				"id",
				"uuid",
				"name",
				"environment_id",
				"server_id",
				"destination_type",
				"destination_id",
				"docker_compose_raw",
				"service_type",
				"connect_to_docker_network",
			),
		},
		{
			key: "serviceParts",
			table: "service_applications",
			softDelete: true,
			constants: { kind: "application" },
			fields: {
				...same(
					"id",
					"service_id",
					"name",
					"fqdn",
					"image",
					"status",
					opt("domain_port_overrides"),
				),
				is_public: null,
				public_port: null,
			},
		},
		{
			key: "serviceParts",
			table: "service_databases",
			softDelete: true,
			constants: { kind: "database" },
			fields: {
				...same(
					"id",
					"service_id",
					"name",
					"image",
					"status",
					"is_public",
					"public_port",
				),
				fqdn: null,
				domain_port_overrides: null,
			},
		},
		...coolifyEngines.map((engine): Query => {
			const t = databaseTables[engine];
			return {
				key: "databases",
				table: t.table,
				softDelete: true,
				// KeyDB, Dragonfly and ClickHouse tables exist in every stable release, but stay optional.
				optionalTable: ![
					"postgres",
					"mysql",
					"mariadb",
					"mongo",
					"redis",
				].includes(engine),
				constants: { engine },
				label: "name",
				fields: {
					...same(
						"id",
						"uuid",
						"name",
						"environment_id",
						"destination_type",
						"destination_id",
						"image",
						"status",
						"is_public",
						"public_port",
						"limits_memory",
						"limits_cpus",
						"custom_docker_run_options",
						opt("enable_ssl"),
					),
					user: t.user,
					password: t.password,
					database: t.database,
					root_password: t.root,
					conf: t.conf,
					init_scripts: engine === "postgres" ? "init_scripts" : null,
				},
				encrypted: { password: {}, root_password: {} },
			};
		}),
		{
			key: "envs",
			table: "environment_variables",
			label: "key",
			fields: same(
				"key",
				"value",
				"resourceable_type",
				"resourceable_id",
				"is_preview",
				"is_buildtime",
				"is_runtime",
				"is_literal",
			),
			encrypted: { value: { serialized: true } },
		},
		{
			key: "sharedEnvs",
			table: "shared_environment_variables",
			label: "key",
			fields: same(
				"key",
				"value",
				"type",
				"team_id",
				"project_id",
				"environment_id",
			),
			encrypted: { value: {} },
		},
		{
			key: "volumes",
			table: "local_persistent_volumes",
			fields: same(
				"name",
				"mount_path",
				"host_path",
				"resource_type",
				"resource_id",
			),
		},
		{
			key: "fileVolumes",
			table: "local_file_volumes",
			label: "resource_id",
			fields: same(
				"fs_path",
				"mount_path",
				"content",
				"is_directory",
				"resource_type",
				"resource_id",
			),
			encrypted: { fs_path: {}, mount_path: {}, content: {} },
		},
		{
			key: "privateKeys",
			table: "private_keys",
			label: "name",
			fields: same("id", "name", "private_key", "is_git_related"),
			encrypted: { private_key: {} },
		},
		{
			key: "githubApps",
			table: "github_apps",
			label: "name",
			fields: same(
				"id",
				"name",
				"api_url",
				"html_url",
				"app_id",
				"installation_id",
				"webhook_secret",
				"private_key_id",
				"is_public",
			),
			encrypted: { webhook_secret: {} },
		},
		{ key: "gitlabApps", table: "gitlab_apps", fields: same("id", "name") },
		{
			key: "s3",
			table: "s3_storages",
			label: "name",
			fields: same(
				"id",
				"name",
				"region",
				"key",
				"secret",
				"bucket",
				"endpoint",
				opt("use_path_style_endpoint"),
			),
			encrypted: { key: {}, secret: {} },
		},
		{
			key: "backups",
			table: "scheduled_database_backups",
			fields: same(
				"id",
				"enabled",
				"save_s3",
				"frequency",
				"database_type",
				"database_id",
				"s3_storage_id",
				"database_backup_retention_amount_s3",
				"dump_all",
			),
		},
		{
			key: "backupDestinations",
			table: "scheduled_database_backup_s3_storage",
			optionalTable: true,
			fields: same("scheduled_database_backup_id", "s3_storage_id"),
		},
		...Object.entries(notificationColumns).map(
			([type, cols]): Query => ({
				key: "notifications",
				table: `${type}_notification_settings`,
				constants: { type },
				label: "team_id",
				fields: {
					team_id: "team_id",
					...Object.fromEntries(
						notificationFields.map((f) => [f, cols[f] ?? null]),
					),
					...Object.fromEntries(
						notificationEvents.map((e) => [e, `${e}_${type}_notifications`]),
					),
				},
				encrypted: Object.fromEntries(
					[
						"webhook_url",
						"telegram_token",
						"telegram_chat_id",
						"smtp_host",
						"smtp_username",
						"smtp_password",
						"smtp_from_address",
						"smtp_recipients",
						"resend_api_key",
						"pushover_user_key",
						"pushover_api_token",
					].map((f) => [f, {}]),
				),
			}),
		),
	];
}

const required = (column: string) => !column.endsWith("?");
const bare = (column: string) => column.replace(/\?$/, "");
const q = (c: string) => `"${c}"`;

/** Required columns of required tables the database lacks, as `table.column`. */
export function missingColumns(
	present: { table: string; column: string }[],
): string[] {
	const have = new Set(present.map((p) => `${p.table}.${p.column}`));
	const tables = new Set(present.map((p) => p.table));
	return queries()
		.filter((query) => !query.optionalTable || tables.has(query.table))
		.flatMap((query) =>
			Object.values(query.fields)
				.filter((c): c is string => c !== null && required(c))
				.map((c) => `${query.table}.${c}`),
		)
		.filter((c) => !have.has(c));
}

/** Every column the reader reads, for the upstream schema test. */
export const readColumns = () =>
	queries().flatMap((query) =>
		Object.values(query.fields)
			.filter((c): c is string => c !== null)
			.map((c) => ({
				table: query.table,
				column: bare(c),
				required: required(c),
				optionalTable: !!query.optionalTable,
			})),
	);

export async function readCoolify(
	url: string,
	opts: { appKey: string },
): Promise<CoolifySnapshot> {
	const keys: LaravelKey[] = [await laravelKey(opts.appKey)];
	const sql = new Bun.SQL(url, { max: 1 });
	try {
		return await sql.begin("read only", async (tx) => {
			const present = (await tx.unsafe(
				`select table_name as "table", column_name as "column" from information_schema.columns where table_schema = 'public'`,
			)) as { table: string; column: string }[];
			const missing = missingColumns(present);
			if (missing.length)
				throw new Error(
					`not a supported Coolify (stable v4.0.0 or later): missing ${missing.join(", ")}`,
				);
			const has = new Set(present.map((p) => `${p.table}.${p.column}`));
			const tables = new Set(present.map((p) => p.table));
			const out: Record<string, unknown[]> = {};
			const undecryptable: CoolifySnapshot["undecryptable"] = [];
			for (const query of queries()) {
				out[query.key] ??= [];
				if (!tables.has(query.table)) continue;
				const select = [
					...Object.entries(query.constants ?? {}).map(
						([f, v]) => `'${v}' as ${q(f)}`,
					),
					...Object.entries(query.fields).map(([f, c]) =>
						c && has.has(`${query.table}.${bare(c)}`)
							? `${q(bare(c))} as ${q(f)}`
							: `null as ${q(f)}`,
					),
				];
				const where =
					query.softDelete && has.has(`${query.table}.deleted_at`)
						? " where deleted_at is null"
						: "";
				const rows = (await tx.unsafe(
					`select ${select.join(", ")} from ${q(query.table)}${where}`,
				)) as Record<string, unknown>[];
				for (const row of rows) {
					for (const [field, how] of Object.entries(query.encrypted ?? {})) {
						const v = row[field];
						if (typeof v !== "string") continue;
						const opened = await openCoolify(v, keys, how);
						if (opened === undefined) {
							undecryptable.push({
								table: query.table,
								id: String(row[query.label ?? "id"] ?? row.id ?? "?"),
								column: field,
							});
							row[field] = null;
						} else row[field] = opened;
					}
					out[query.key]?.push(row);
				}
			}
			return CoolifySnapshot.parse({ ...out, undecryptable });
		});
	} finally {
		await sql.close();
	}
}
