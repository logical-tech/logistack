import { describe, expect, test } from "bun:test";
import { buildCoolifyInventory } from "../src/migration/coolify/inventory.ts";
import type {
	CoolifyApplication,
	CoolifyDatabase,
	CoolifySnapshot,
} from "../src/migration/coolify/snapshot.ts";

const DOCKER = "App\\Models\\StandaloneDocker";
const APP = "App\\Models\\Application";
const PG = "App\\Models\\StandalonePostgresql";

const app = (over: Partial<CoolifyApplication> = {}): CoolifyApplication => ({
	id: 1,
	uuid: "webq0c8o4wk4gk8ows8sg",
	name: "shop-web",
	environment_id: 1,
	destination_type: DOCKER,
	destination_id: 1,
	fqdn: "https://shop.example.com",
	git_repository: "coollabsio/coolify",
	git_branch: "main",
	git_commit_sha: "HEAD",
	docker_registry_image_name: "nginx",
	docker_registry_image_tag: "1.27-alpine",
	build_pack: "dockerimage",
	static_image: null,
	install_command: null,
	build_command: null,
	start_command: null,
	ports_exposes: "80",
	ports_mappings: null,
	base_directory: "/",
	publish_directory: null,
	dockerfile: null,
	dockerfile_location: "/Dockerfile",
	dockerfile_target_build: null,
	docker_compose_location: null,
	docker_compose_raw: null,
	docker_compose_domains: null,
	source_type: null,
	source_id: null,
	private_key_id: null,
	custom_labels: null,
	custom_docker_run_options: null,
	health_check_enabled: false,
	health_check_path: "/",
	health_check_port: null,
	limits_memory: "0",
	limits_cpus: "0",
	status: "running:healthy",
	pre_deployment_command: null,
	post_deployment_command: null,
	is_http_basic_auth_enabled: false,
	http_basic_auth_username: null,
	http_basic_auth_password: null,
	domain_port_overrides: null,
	...over,
});

const pg = (over: Partial<CoolifyDatabase> = {}): CoolifyDatabase => ({
	engine: "postgres",
	id: 1,
	uuid: "pgk8s0wc8gw4o0c4ws0ok",
	name: "shop-db",
	environment_id: 1,
	destination_type: DOCKER,
	destination_id: 1,
	image: "postgres:17-alpine",
	status: "running:healthy",
	is_public: false,
	public_port: null,
	limits_memory: "512m",
	limits_cpus: "0.5",
	custom_docker_run_options: null,
	enable_ssl: false,
	user: "shop",
	password: "fake-coolify-pg-secret",
	database: "shop",
	root_password: null,
	conf: null,
	init_scripts: null,
	...over,
});

const snapshot = (over: Partial<CoolifySnapshot> = {}): CoolifySnapshot => ({
	servers: [{ id: 0, name: "localhost" }],
	destinations: [
		{ id: 1, server_id: 0, network: "coolify" },
		{ id: 2, server_id: 5, network: "coolify" },
	],
	teams: [{ id: 0, name: "Root Team" }],
	projects: [{ id: 1, uuid: "p1", name: "Shop", team_id: 0 }],
	environments: [{ id: 1, uuid: "e1", name: "production", project_id: 1 }],
	applications: [],
	applicationSettings: [],
	services: [],
	serviceParts: [],
	databases: [],
	envs: [],
	sharedEnvs: [],
	volumes: [],
	fileVolumes: [],
	privateKeys: [],
	githubApps: [],
	gitlabApps: [],
	s3: [],
	backups: [],
	backupDestinations: [],
	notifications: [],
	undecryptable: [],
	...over,
});

const env = (key: string, value: string | null, over = {}) => ({
	key,
	value,
	resourceable_type: APP,
	resourceable_id: 1,
	is_preview: false,
	is_buildtime: true,
	is_runtime: true,
	is_literal: false,
	...over,
});

describe("Coolify applications", () => {
	test("an image app keeps its domains, env and shared references; Traefik routes it by labels", () => {
		const { items } = buildCoolifyInventory(
			snapshot({
				applications: [
					app({
						fqdn: "https://shop.example.com,http://api.example.com:3000/v1",
						health_check_enabled: true,
						health_check_path: "/health",
						limits_memory: "1g",
					}),
				],
				envs: [
					env(
						"DATABASE_URL",
						"postgres://shop:fake-pw@pgk8s0wc8gw4o0c4ws0ok:5432/shop",
					),
					env("REGION", "{{project.REGION}}"),
					env("ALIAS", "$REGION"),
					env("DATABASE_URL", "preview-only", { is_preview: true }),
				],
				sharedEnvs: [
					{
						key: "REGION",
						value: "eu-west",
						type: "project",
						team_id: 0,
						project_id: 1,
						environment_id: null,
					},
				],
			}),
		);
		const [item] = items;
		expect(item).toMatchObject({
			kind: "application",
			sourceId: "webq0c8o4wk4gk8ows8sg",
			status: "full",
			project: "Shop",
			environment: "production",
			source: {
				containerLabels: [
					"coolify.managed=true",
					"com.docker.compose.project=webq0c8o4wk4gk8ows8sg",
				],
				routedByLabels: true,
			},
		});
		const [svc] = item?.services ?? [];
		expect(svc).toMatchObject({
			slug: "shop-web-webq0c8o",
			importedFrom: "coolify:webq0c8o4wk4gk8ows8sg",
			bridge: {
				aliases: ["shop-web-webq0c8o", "webq0c8o4wk4gk8ows8sg"],
				routes: true,
			},
			running: true,
			spec: {
				source: { type: "image", image: "nginx:1.27-alpine" },
				resources: { memoryMb: 1024 },
				healthcheck: { type: "http", port: 80, path: "/health" },
			},
		});
		expect(svc?.domains).toEqual([
			expect.objectContaining({
				hostname: "shop.example.com",
				port: 80,
				https: true,
			}),
			expect.objectContaining({
				hostname: "api.example.com",
				port: 3000,
				pathPrefix: "/v1",
				https: false,
			}),
		]);
		expect(svc?.env).toEqual([
			expect.objectContaining({ key: "DATABASE_URL" }),
			{ key: "REGION", value: "eu-west", isSecret: true },
			{ key: "ALIAS", value: "{{project.REGION}}", isSecret: false },
		]);
	});

	test("git sources: a GitHub App keeps its provider, a public repo becomes its URL, Nixpacks becomes Railpack", () => {
		const { items } = buildCoolifyInventory(
			snapshot({
				applications: [
					app({
						id: 1,
						uuid: "a1",
						name: "api",
						build_pack: "nixpacks",
						git_repository: "acme/api",
						git_branch: "prod",
						base_directory: "/services/api",
						source_type: "App\\Models\\GithubApp",
						source_id: 3,
						start_command: "bun run start",
					}),
					app({
						id: 2,
						uuid: "a2",
						name: "site",
						build_pack: "static",
						publish_directory: "/dist",
						git_repository: "acme/site",
						source_type: "App\\Models\\GithubApp",
						source_id: 0,
					}),
					app({
						id: 3,
						uuid: "a3",
						name: "inline",
						build_pack: "dockerfile",
						dockerfile: "FROM nginx",
					}),
				],
				githubApps: [
					{
						id: 0,
						name: "Public GitHub",
						api_url: null,
						html_url: "https://github.com",
						app_id: null,
						installation_id: null,
						webhook_secret: null,
						private_key_id: null,
						is_public: true,
					},
					{
						id: 3,
						name: "acme",
						api_url: null,
						html_url: "https://github.com",
						app_id: 1,
						installation_id: 2,
						webhook_secret: "s",
						private_key_id: 9,
						is_public: false,
					},
				],
			}),
		);
		const [api, site, inline] = items;
		expect(api?.services[0]).toMatchObject({
			spec: {
				source: {
					type: "git",
					repository: "acme/api",
					branch: "prod",
					path: "services/api",
				},
				build: { type: "railpack" },
			},
			gitProvider: { type: "github", sourceId: "3" },
		});
		expect(api?.notes).toContain("built with Railpack instead of Nixpacks");
		expect(site?.services[0]?.spec).toMatchObject({
			source: { repository: "https://github.com/acme/site" },
			build: { type: "static", publishDir: "dist" },
		});
		expect(inline?.status).toBe("unsupported");
	});

	test("a remote server, a Swarm destination or a deploy key is unsupported", () => {
		const { items } = buildCoolifyInventory(
			snapshot({
				applications: [
					app({ uuid: "r1", destination_id: 2 }),
					app({ uuid: "r2", destination_type: "App\\Models\\SwarmDocker" }),
					app({
						uuid: "r3",
						build_pack: "nixpacks",
						git_repository: "git@github.com:acme/x.git",
						private_key_id: 4,
					}),
				],
			}),
		);
		expect(items.map((i) => [i.status, i.notes[0]])).toEqual([
			["unsupported", "runs on a remote Coolify server"],
			["unsupported", "runs on a Swarm destination in Coolify"],
			[
				"unsupported",
				"deploys through an SSH deploy key; connect the repository through a provider",
			],
		]);
	});
});

describe("Coolify databases", () => {
	test("an official image adopts its data volume and keeps Coolify's credentials and backups", () => {
		const { items } = buildCoolifyInventory(
			snapshot({
				databases: [pg()],
				volumes: [
					{
						name: "postgres-data-pgk8s0wc8gw4o0c4ws0ok",
						mount_path: "/var/lib/postgresql/data",
						host_path: null,
						resource_type: PG,
						resource_id: 1,
					},
				],
				s3: [
					{
						id: 1,
						name: "minio",
						region: "us-east-1",
						key: "k",
						secret: "s",
						bucket: "backups",
						endpoint: "https://minio.example.com",
						use_path_style_endpoint: true,
					},
				],
				backups: [
					{
						id: 1,
						enabled: true,
						save_s3: true,
						frequency: "daily",
						database_type: PG,
						database_id: 1,
						s3_storage_id: 1,
						database_backup_retention_amount_s3: 7,
						dump_all: false,
					},
				],
				backupDestinations: [
					{ scheduled_database_backup_id: 1, s3_storage_id: 1 },
				],
			}),
		);
		const [item] = items;
		expect(item?.status).toBe("full");
		expect(item?.services[0]).toMatchObject({
			slug: "pgk8s0wc8gw4o0c4ws0ok",
			spec: {
				engine: "postgres",
				version: "17-alpine",
				resources: { memoryMb: 512, cpu: 0.5 },
			},
			adoptedVolumes: [
				{
					target: "/var/lib/postgresql/data",
					volume: "postgres-data-pgk8s0wc8gw4o0c4ws0ok",
					source: "coolify",
				},
			],
			env: [
				{ key: "POSTGRES_USER", value: "shop", isSecret: false },
				{
					key: "POSTGRES_PASSWORD",
					value: "fake-coolify-pg-secret",
					isSecret: true,
				},
				{ key: "POSTGRES_DB", value: "shop", isSecret: false },
			],
			backups: [
				{
					destination: "1",
					cron: "0 0 * * *",
					retention: { count: 7 },
					enabled: true,
				},
			],
			bridge: { aliases: ["pgk8s0wc8gw4o0c4ws0ok"], routes: false },
		});
	});

	test("Postgres 18 adopts Coolify's volume where LogiStack mounts it, without PGDATA", () => {
		const { items } = buildCoolifyInventory(
			snapshot({
				databases: [pg({ image: "postgres:18" })],
				volumes: [
					{
						name: "postgres-data-x",
						mount_path: "/var/lib/postgresql",
						host_path: null,
						resource_type: PG,
						resource_id: 1,
					},
				],
			}),
		);
		expect(items[0]?.services[0]?.adoptedVolumes[0]?.target).toBe(
			"/var/lib/postgresql",
		);
		expect(items[0]?.services[0]?.env.some((e) => e.key === "PGDATA")).toBe(
			false,
		);
	});

	test("SSL, an engine LogiStack lacks, a custom image or a missing volume is unsupported", () => {
		const { items } = buildCoolifyInventory(
			snapshot({
				databases: [
					pg({ uuid: "d1", enable_ssl: true }),
					pg({ uuid: "d2", engine: "keydb", image: "eqalpha/keydb:latest" }),
					pg({ uuid: "d3", image: "pgvector/pgvector:pg16" }),
					pg({ uuid: "d4" }),
				],
			}),
		);
		expect(items.map((i) => i.status)).toEqual([
			"unsupported",
			"unsupported",
			"unsupported",
			"unsupported",
		]);
		expect(items[3]?.notes[0]).toContain(
			"no volume mounted at /var/lib/postgresql/data",
		);
	});
});

describe("Coolify one-click services", () => {
	test("a template splits into services, keeps its generated passwords, adopts its volumes", () => {
		const { items } = buildCoolifyInventory(
			snapshot({
				services: [
					{
						id: 1,
						uuid: "svcm4sgkso8c0gw0skwcg",
						name: "blog",
						environment_id: 1,
						server_id: 0,
						destination_type: DOCKER,
						destination_id: 1,
						service_type: "ghost",
						connect_to_docker_network: false,
						docker_compose_raw: `services:
  app:
    image: nginx:1.27-alpine
    environment:
      - SERVICE_FQDN_APP_2368
      - SECRET=\${SERVICE_PASSWORD_APP}
    depends_on: [cache]
    healthcheck:
      test: ["CMD", "true"]
  cache:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - cache-data:/data
    exclude_from_hc: true
`,
					},
				],
				serviceParts: [
					{
						id: 1,
						service_id: 1,
						name: "app",
						kind: "application",
						fqdn: "https://blog.example.com",
						image: null,
						status: "running:healthy",
						is_public: null,
						public_port: null,
						domain_port_overrides: null,
					},
					{
						id: 1,
						service_id: 1,
						name: "cache",
						kind: "database",
						fqdn: null,
						image: null,
						status: "exited:unhealthy",
						is_public: false,
						public_port: null,
						domain_port_overrides: null,
					},
				],
				envs: [
					env("SERVICE_PASSWORD_APP", "fake-coolify-svc-secret", {
						resourceable_type: "App\\Models\\Service",
					}),
					env("SERVICE_FQDN_APP_2368", "blog.example.com", {
						resourceable_type: "App\\Models\\Service",
					}),
				],
			}),
		);
		const [item] = items;
		expect(item?.status).toBe("full");
		expect(item?.services.map((s) => s.slug)).toEqual(["cache", "app"]);
		const [cache, web] = item?.services ?? [];
		expect(cache).toMatchObject({
			importedFrom: "coolify:svcm4sgkso8c0gw0skwcg/cache",
			adoptedVolumes: [
				{
					target: "/data",
					volume: "svcm4sgkso8c0gw0skwcg_cache-data",
					source: "coolify",
				},
			],
			spec: { command: ["redis-server", "--appendonly", "yes"] },
			running: false,
			bridge: { aliases: ["cache-svcm4sgkso8c0gw0skwcg"], routes: false },
		});
		expect(web).toMatchObject({
			domains: [
				expect.objectContaining({ hostname: "blog.example.com", port: 2368 }),
			],
			bridge: { aliases: ["app-svcm4sgkso8c0gw0skwcg"], routes: true },
			spec: { healthcheck: { type: "command", command: ["true"] } },
		});
		expect(web?.env).toContainEqual(
			expect.objectContaining({
				key: "SECRET",
				value: "fake-coolify-svc-secret",
			}),
		);
	});

	test("a template with a build or a custom network is refused as a whole", () => {
		const { items } = buildCoolifyInventory(
			snapshot({
				services: [
					{
						id: 1,
						uuid: "s1",
						name: "x",
						environment_id: 1,
						server_id: 0,
						destination_type: DOCKER,
						destination_id: 1,
						service_type: null,
						connect_to_docker_network: false,
						docker_compose_raw: "services:\n  a:\n    build: .\n",
					},
				],
			}),
		);
		expect(items[0]?.status).toBe("unsupported");
		expect(items[0]?.notes).toContain("services.a.build");
	});
});

test("an app and a one-click service's part with one name share an environment", () => {
	const { items } = buildCoolifyInventory(
		snapshot({
			applications: [app({ name: "web" })],
			services: [
				{
					id: 1,
					uuid: "svc1",
					name: "blog",
					environment_id: 1,
					server_id: 0,
					destination_type: DOCKER,
					destination_id: 1,
					service_type: null,
					connect_to_docker_network: false,
					docker_compose_raw: "services:\n  web:\n    image: nginx:alpine\n",
				},
			],
		}),
	);
	expect(items.map((i) => [i.services[0]?.slug, i.status])).toEqual([
		["web-webq0c8o", "full"],
		["web", "full"],
	]);
});

test("a value Coolify's key does not open is named, never echoed; no secret reaches a note", () => {
	const { items, org } = buildCoolifyInventory(
		snapshot({
			applications: [app({ http_basic_auth_password: "fake-basic-secret" })],
			envs: [env("API_TOKEN", null), env("bad key", "fake-bad-secret")],
			undecryptable: [
				{ table: "environment_variables", id: "API_TOKEN", column: "value" },
			],
			notifications: [
				{
					type: "email",
					team_id: 0,
					enabled: null,
					webhook_url: null,
					telegram_token: null,
					telegram_chat_id: null,
					smtp_enabled: true,
					smtp_host: "smtp.example.com",
					smtp_port: 587,
					smtp_encryption: "tls",
					smtp_username: "ops",
					smtp_password: "fake-smtp-secret",
					smtp_from_address: "ops@example.com",
					smtp_recipients: "a@example.com,b@example.com",
					resend_enabled: false,
					resend_api_key: null,
					use_instance_email_settings: false,
					pushover_user_key: null,
					pushover_api_token: null,
					deployment_success: false,
					deployment_failure: true,
					backup_success: false,
					backup_failure: true,
					server_disk_usage: false,
					status_change: false,
					scheduled_task_success: false,
					scheduled_task_failure: false,
					docker_cleanup_success: false,
					docker_cleanup_failure: false,
					server_unreachable: false,
				},
			],
		}),
	);
	expect(items[0]?.notes).toContain(
		"env API_TOKEN could not be decrypted with Coolify's APP_KEY; set it here by hand",
	);
	expect(org[0]).toMatchObject({
		kind: "notificationChannel",
		status: "full",
		draft: {
			input: {
				kind: "email",
				config: {
					host: "smtp.example.com",
					to: ["a@example.com", "b@example.com"],
				},
			},
			events: ["deployment.failed", "backup.failed"],
		},
	});
	const notes = JSON.stringify([...items, ...org].map((i) => i.notes));
	for (const secret of [
		"fake-smtp-secret",
		"fake-basic-secret",
		"fake-bad-secret",
	])
		expect(notes).not.toContain(secret);
});
