/**
 * The rows the Coolify reader takes from Coolify's database (stable v4, 4.0.0 and later), parsed
 * at the boundary. Secrets are already decrypted; a value no key opened is null and named in
 * `undecryptable`, never kept as ciphertext.
 */
import { z } from "zod";

const id = z.coerce.number().int();
const text = z.string().nullable();
const flag = z.boolean().nullable();
const num = z.coerce.number().nullable();

export const coolifyEngines = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"keydb",
	"dragonfly",
	"clickhouse",
] as const;
export type CoolifyEngine = (typeof coolifyEngines)[number];

/** `App\Models\StandaloneDocker` + id: where a resource runs. */
const destination = {
	destination_type: text,
	destination_id: num,
};

export const CoolifyApplication = z.object({
	id,
	uuid: z.string(),
	name: z.string(),
	environment_id: id,
	...destination,
	fqdn: text,
	git_repository: text,
	git_branch: text,
	git_commit_sha: text,
	docker_registry_image_name: text,
	docker_registry_image_tag: text,
	build_pack: z.string(),
	static_image: text,
	install_command: text,
	build_command: text,
	start_command: text,
	ports_exposes: text,
	ports_mappings: text,
	base_directory: text,
	publish_directory: text,
	dockerfile: text,
	dockerfile_location: text,
	dockerfile_target_build: text,
	docker_compose_location: text,
	docker_compose_raw: text,
	docker_compose_domains: text,
	source_type: text,
	source_id: num,
	private_key_id: num,
	custom_labels: text,
	custom_docker_run_options: text,
	health_check_enabled: flag,
	health_check_path: text,
	health_check_port: text,
	limits_memory: text,
	limits_cpus: text,
	status: text,
	pre_deployment_command: text,
	post_deployment_command: text,
	is_http_basic_auth_enabled: flag,
	http_basic_auth_username: text,
	http_basic_auth_password: text,
	/** Not in 4.0.0. */
	domain_port_overrides: text,
});
export type CoolifyApplication = z.infer<typeof CoolifyApplication>;

export const CoolifyApplicationSettings = z.object({
	application_id: id,
	is_static: flag,
	is_spa: flag,
	is_preview_deployments_enabled: flag,
	is_consistent_container_name_enabled: flag,
	custom_internal_name: text,
	connect_to_docker_network: flag,
	is_raw_compose_deployment_enabled: flag,
	is_build_server_enabled: flag,
	is_gpu_enabled: flag,
});
export type CoolifyApplicationSettings = z.infer<
	typeof CoolifyApplicationSettings
>;

export const CoolifyService = z.object({
	id,
	uuid: z.string(),
	name: z.string(),
	environment_id: id,
	server_id: num,
	...destination,
	docker_compose_raw: z.string(),
	service_type: text,
	connect_to_docker_network: flag,
});
export type CoolifyService = z.infer<typeof CoolifyService>;

/** A compose service of a one-click service: `name` is its compose key. */
export const CoolifyServicePart = z.object({
	id,
	service_id: id,
	name: z.string(),
	kind: z.enum(["application", "database"]),
	fqdn: text,
	image: text,
	status: text,
	is_public: flag,
	public_port: num,
	/** Not in 4.0.0. */
	domain_port_overrides: text,
});
export type CoolifyServicePart = z.infer<typeof CoolifyServicePart>;

export const CoolifyDatabase = z.object({
	engine: z.enum(coolifyEngines),
	id,
	uuid: z.string(),
	name: z.string(),
	environment_id: id,
	...destination,
	image: z.string(),
	status: text,
	is_public: flag,
	public_port: num,
	limits_memory: text,
	limits_cpus: text,
	custom_docker_run_options: text,
	enable_ssl: flag,
	user: text,
	password: text,
	database: text,
	root_password: text,
	/** A custom `postgresql.conf`/`my.cnf`/`mongod.conf`/`redis.conf`. */
	conf: text,
	init_scripts: text,
});
export type CoolifyDatabase = z.infer<typeof CoolifyDatabase>;

export const CoolifyEnv = z.object({
	key: z.string(),
	value: text,
	resourceable_type: z.string(),
	resourceable_id: id,
	is_preview: flag,
	is_buildtime: flag,
	is_runtime: flag,
	is_literal: flag,
});
export type CoolifyEnv = z.infer<typeof CoolifyEnv>;

export const CoolifySharedEnv = z.object({
	key: z.string(),
	value: text,
	type: z.string(),
	team_id: num,
	project_id: num,
	environment_id: num,
});
export type CoolifySharedEnv = z.infer<typeof CoolifySharedEnv>;

export const CoolifyVolume = z.object({
	name: z.string(),
	mount_path: z.string(),
	host_path: text,
	resource_type: z.string(),
	resource_id: id,
});
export type CoolifyVolume = z.infer<typeof CoolifyVolume>;

export const CoolifyFileVolume = z.object({
	fs_path: z.string(),
	mount_path: z.string(),
	content: text,
	is_directory: flag,
	resource_type: z.string(),
	resource_id: id,
});
export type CoolifyFileVolume = z.infer<typeof CoolifyFileVolume>;

export const CoolifyPrivateKey = z.object({
	id,
	name: z.string(),
	private_key: text,
	is_git_related: flag,
});

export const CoolifyGithubApp = z.object({
	id,
	name: z.string(),
	api_url: text,
	html_url: text,
	app_id: num,
	installation_id: num,
	webhook_secret: text,
	private_key_id: num,
	is_public: flag,
});

export const CoolifyGitlabApp = z.object({ id, name: z.string() });

export const CoolifyS3 = z.object({
	id,
	name: z.string(),
	region: text,
	key: text,
	secret: text,
	bucket: text,
	endpoint: text,
	/** Not in 4.0.0. */
	use_path_style_endpoint: flag,
});

export const CoolifyBackup = z.object({
	id,
	enabled: flag,
	save_s3: flag,
	frequency: z.string(),
	database_type: z.string(),
	database_id: id,
	s3_storage_id: num,
	database_backup_retention_amount_s3: num,
	dump_all: flag,
});
export type CoolifyBackup = z.infer<typeof CoolifyBackup>;

/** The M:N destinations of a backup (since 2026-10); absent tables read as none. */
export const CoolifyBackupDestination = z.object({
	scheduled_database_backup_id: id,
	s3_storage_id: id,
});

export const coolifyNotificationTypes = [
	"discord",
	"slack",
	"telegram",
	"email",
	"pushover",
	"webhook",
] as const;
export type CoolifyNotificationType = (typeof coolifyNotificationTypes)[number];

/** One team's settings of one notification type, unified: events are the switches that are on. */
export const CoolifyNotification = z.object({
	type: z.enum(coolifyNotificationTypes),
	team_id: id,
	enabled: flag,
	webhook_url: text,
	telegram_token: text,
	telegram_chat_id: text,
	smtp_enabled: flag,
	smtp_host: text,
	smtp_port: num,
	smtp_encryption: text,
	smtp_username: text,
	smtp_password: text,
	smtp_from_address: text,
	smtp_recipients: text,
	resend_enabled: flag,
	resend_api_key: text,
	use_instance_email_settings: flag,
	pushover_user_key: text,
	pushover_api_token: text,
	deployment_success: flag,
	deployment_failure: flag,
	backup_success: flag,
	backup_failure: flag,
	server_disk_usage: flag,
	status_change: flag,
	scheduled_task_success: flag,
	scheduled_task_failure: flag,
	docker_cleanup_success: flag,
	docker_cleanup_failure: flag,
	server_unreachable: flag,
});
export type CoolifyNotification = z.infer<typeof CoolifyNotification>;

export const CoolifySnapshot = z.object({
	servers: z.array(z.object({ id, name: z.string() })),
	/** `standalone_dockers`: Docker networks on a server. */
	destinations: z.array(z.object({ id, server_id: id, network: z.string() })),
	teams: z.array(z.object({ id, name: z.string() })),
	projects: z.array(
		z.object({ id, uuid: z.string(), name: z.string(), team_id: id }),
	),
	environments: z.array(
		z.object({ id, uuid: z.string(), name: z.string(), project_id: id }),
	),
	applications: z.array(CoolifyApplication),
	applicationSettings: z.array(CoolifyApplicationSettings),
	services: z.array(CoolifyService),
	serviceParts: z.array(CoolifyServicePart),
	databases: z.array(CoolifyDatabase),
	envs: z.array(CoolifyEnv),
	sharedEnvs: z.array(CoolifySharedEnv),
	volumes: z.array(CoolifyVolume),
	fileVolumes: z.array(CoolifyFileVolume),
	privateKeys: z.array(CoolifyPrivateKey),
	githubApps: z.array(CoolifyGithubApp),
	gitlabApps: z.array(CoolifyGitlabApp),
	s3: z.array(CoolifyS3),
	backups: z.array(CoolifyBackup),
	backupDestinations: z.array(CoolifyBackupDestination),
	notifications: z.array(CoolifyNotification),
	/** `table.column` of a named row whose value no key opened (`environment_variables.value` of `KEY`). */
	undecryptable: z.array(
		z.object({ table: z.string(), id: z.string(), column: z.string() }),
	),
});
export type CoolifySnapshot = z.infer<typeof CoolifySnapshot>;
