import type { StackDetail } from "../stacks";
import type {
	BackupRunListItem,
	CertificateSummary,
	Deployment,
	DeploymentStatus,
	DeploymentTrigger,
	Environment,
	EnvironmentKind,
	Folder,
	ObservedStatus,
	Project,
	Service,
	ServiceSpec,
} from "../types";

const ORG = "org_logical";
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const ahead = (days: number) => new Date(now + days * 86_400_000).toISOString();

export type MockStack = Omit<StackDetail, "services" | "effectiveCompose">;

export type MockDb = {
	folders: Folder[];
	stacks: MockStack[];
	projects: Project[];
	environments: Environment[];
	services: Service[];
	deployments: Deployment[];
	certificates: CertificateSummary[];
	backupRuns: Omit<BackupRunListItem, "service" | "project">[];
	backupServiceIds: Record<string, Service["id"]>;
	setupCompleted: boolean;
	publicIp: string;
};

const folder = (
	id: string,
	name: string,
	parentId: string | null,
	position: number,
): Folder => ({
	id: `fld_${id}`,
	organizationId: ORG,
	parentId: parentId ? `fld_${parentId}` : null,
	name,
	slug: id,
	position,
	createdAt: ago(60 * 24 * 90),
	updatedAt: ago(60 * 24 * 90),
});

const project = (
	id: string,
	name: string,
	description: string,
	folderId: string | null,
	createdDaysAgo: number,
): Project => ({
	id: `prj_${id}`,
	organizationId: ORG,
	folderId: folderId ? `fld_${folderId}` : null,
	name,
	slug: id,
	description,
	createdAt: ago(createdDaysAgo * 1440),
	updatedAt: ago(createdDaysAgo * 90),
});

const ENV_NAMES: Record<EnvironmentKind, string> = {
	production: "Production",
	staging: "Staging",
	preview: "Preview",
	custom: "Custom",
};

const environment = (
	projectId: string,
	kind: EnvironmentKind,
	isDefault = kind === "production",
): Environment => ({
	id: `env_${projectId}_${kind}`,
	projectId: `prj_${projectId}`,
	name: ENV_NAMES[kind],
	slug: kind,
	kind,
	isDefault,
	createdAt: ago(60 * 24 * 90),
	updatedAt: ago(60 * 24 * 90),
});

const git = (repository: string, branch = "main", path = "/") =>
	({ type: "git", repository, branch, path }) as const;

const app = (
	source: ReturnType<typeof git> | { type: "image"; image: string },
	port: number,
	replicas = 1,
	build: "dockerfile" | "railpack" | "static" | "image" = source.type ===
	"image"
		? "image"
		: "dockerfile",
): ServiceSpec => ({
	kind: "application",
	source,
	build:
		build === "dockerfile"
			? { type: build, dockerfilePath: "Dockerfile", context: "." }
			: build === "static"
				? { type: build, publishDir: "dist" }
				: { type: build },
	ports: port ? [{ target: port, protocol: "tcp" }] : [],
	replicas,
	resources: { cpu: 1, memoryMb: 512 },
	placement: [],
});

const db = (
	engine: "postgres" | "mysql" | "mariadb" | "mongo" | "redis",
	version: string,
): ServiceSpec => ({
	kind: "database",
	engine,
	version,
	credentialsRef: `cred_${engine}`,
	resources: { cpu: 1, memoryMb: 1024 },
});

const storage = (
	engine: "minio" | "rustfs" | "garage" | "seaweedfs",
): ServiceSpec => ({
	kind: "storage",
	engine,
	resources: { cpu: 1, memoryMb: 1024 },
});

let depCounter = 0;
const deployments: Deployment[] = [];

function deploy(
	serviceId: Service["id"],
	status: DeploymentStatus,
	startedMinutesAgo: number,
	durationSeconds: number | null,
	trigger: DeploymentTrigger,
	commit: [string, string] | null,
	error: string | null = null,
): Deployment {
	depCounter += 1;
	const started = now - startedMinutesAgo * 60_000;
	const d: Deployment = {
		id: `dep_${(1000 + depCounter).toString(36)}${serviceId.slice(4, 8)}`,
		serviceId,
		status,
		trigger,
		commitSha: commit?.[0] ?? null,
		commitMessage: commit?.[1] ?? null,
		gitRef: null,
		imageRef: `registry.logical.it/logical/${serviceId.slice(4)}:dep_${depCounter}`,
		platforms: ["linux/amd64", "linux/arm64"],
		startedAt: new Date(started).toISOString(),
		finishedAt:
			durationSeconds === null
				? null
				: new Date(started + durationSeconds * 1000).toISOString(),
		error,
		reason: null,
		logPath: null,
		supersededBy: null,
		createdAt: new Date(started).toISOString(),
		updatedAt: new Date(started).toISOString(),
	};
	deployments.push(d);
	return d;
}

const PLAUSIBLE_COMPOSE = `services:
  plausible:
    image: ghcr.io/plausible/community-edition:v3.1
    ports: ["8000"]
    environment:
      BASE_URL: https://stats.logical.it
      SECRET_KEY_BASE: \${SECRET_KEY_BASE:-change-me}
      DATABASE_URL: postgres://postgres:postgres@plausible-db:5432/plausible
      CLICKHOUSE_DATABASE_URL: http://clickhouse:8123/plausible
    depends_on: [plausible-db, clickhouse]
  plausible-db:
    image: postgres:16.4
    environment:
      POSTGRES_PASSWORD: postgres
    volumes: ["db-data:/var/lib/postgresql/data"]
  clickhouse:
    image: clickhouse/clickhouse-server:25.8-alpine
    volumes: ["event-data:/var/lib/clickhouse"]
volumes:
  db-data: {}
  event-data: {}
`;

function service(
	envId: Environment["id"],
	slug: string,
	name: string,
	spec: ServiceSpec,
	observed: ObservedStatus,
	domains: string[] = [],
	replicas: [number, number] = [1, 1],
): Service {
	const kind = spec.kind;
	return {
		id: `svc_${envId.slice(4)}_${slug}`,
		environmentId: envId,
		name,
		slug,
		kind,
		spec,
		desiredState: observed === "stopped" ? "stopped" : "running",
		status: {
			observed,
			replicasRunning: replicas[0],
			replicasDesired: replicas[1],
			observedAt: ago(1),
		},
		latestDeployment: null,
		domains,
		nodeId: null,
		createdBy: null,
		icon: null,
		importedFrom: null,
		stackId: null,
		createdAt: ago(60 * 24 * 30),
		updatedAt: ago(60 * 24 * 30),
	};
}

export function createMockDb(): MockDb {
	depCounter = 0;
	deployments.length = 0;

	const folders = [
		folder("clients", "Clients", null, 0),
		folder("acme", "Acme Retail", "clients", 0),
		folder("nordwind", "Nordwind Travel", "clients", 1),
		folder("internal", "Internal", null, 1),
		folder("labs", "Labs", "internal", 0),
	];

	const projects = [
		project(
			"storefront",
			"Storefront",
			"Customer-facing shop and checkout",
			"acme",
			210,
		),
		project(
			"backoffice",
			"Back office",
			"Order management and returns desk",
			"acme",
			180,
		),
		project(
			"booking",
			"Booking API",
			"Availability, quotes and reservations",
			"nordwind",
			96,
		),
		project("rossi", "Studio Rossi", "Portfolio site and CMS", "clients", 44),
		project(
			"status",
			"Status page",
			"Public uptime page for all clients",
			"internal",
			320,
		),
		project(
			"analytics",
			"Analytics",
			"Plausible and ClickHouse for every site",
			"internal",
			140,
		),
		project(
			"llm-gateway",
			"LLM gateway",
			"Prototype proxy with per-key budgets",
			"labs",
			12,
		),
		project("website", "logical.it", "Company website", null, 400),
	];

	const environments: Environment[] = [
		environment("storefront", "production"),
		environment("storefront", "staging"),
		environment("storefront", "preview"),
		environment("backoffice", "production"),
		environment("backoffice", "staging"),
		environment("booking", "production"),
		environment("booking", "staging"),
		environment("rossi", "production"),
		environment("status", "production"),
		environment("analytics", "production"),
		environment("llm-gateway", "staging", true),
		environment("website", "production"),
		environment("website", "preview"),
	];

	const e = (p: string, k: EnvironmentKind) => `env_${p}_${k}` as const;
	const services: Service[] = [
		service(
			e("storefront", "production"),
			"web",
			"web",
			app(git("github.com/acme-retail/storefront"), 3000, 3),
			"running",
			["shop.acme-retail.it"],
			[3, 3],
		),
		service(
			e("storefront", "production"),
			"api",
			"api",
			app(
				git("github.com/acme-retail/storefront", "main", "/apps/api"),
				8080,
				2,
			),
			"running",
			["api.acme-retail.it"],
			[2, 2],
		),
		service(
			e("storefront", "production"),
			"worker",
			"worker",
			app(
				git("github.com/acme-retail/storefront", "main", "/apps/worker"),
				0,
				2,
			),
			"unhealthy",
			[],
			[1, 2],
		),
		service(
			e("storefront", "production"),
			"postgres",
			"postgres",
			db("postgres", "17.6"),
			"running",
		),
		service(
			e("storefront", "production"),
			"redis",
			"redis",
			db("redis", "8.2"),
			"running",
		),
		service(
			e("storefront", "production"),
			"catalog",
			"catalog",
			db("mongo", "8.0"),
			"running",
		),
		service(
			e("storefront", "staging"),
			"web",
			"web",
			app(git("github.com/acme-retail/storefront", "develop"), 3000),
			"running",
			["web-staging.49-12-88-7.sslip.io"],
		),
		service(
			e("storefront", "staging"),
			"api",
			"api",
			app(
				git("github.com/acme-retail/storefront", "develop", "/apps/api"),
				8080,
			),
			"starting",
			[],
			[0, 1],
		),
		service(
			e("storefront", "staging"),
			"postgres",
			"postgres",
			db("postgres", "17.6"),
			"running",
		),
		service(
			e("storefront", "preview"),
			"web-pr-412",
			"web · PR #412",
			app(git("github.com/acme-retail/storefront", "feat/gift-cards"), 3000),
			"running",
			["web-pr-412.49-12-88-7.sslip.io"],
		),
		service(
			e("backoffice", "production"),
			"app",
			"app",
			app(git("github.com/acme-retail/backoffice"), 4000),
			"running",
			["office.acme-retail.it"],
		),
		service(
			e("backoffice", "production"),
			"mysql",
			"mysql",
			db("mysql", "8.4"),
			"running",
		),
		service(
			e("backoffice", "staging"),
			"app",
			"app",
			app(git("github.com/acme-retail/backoffice", "develop"), 4000),
			"stopped",
			[],
			[0, 0],
		),
		service(
			e("booking", "production"),
			"api",
			"api",
			app(git("gitlab.com/nordwind/booking"), 8000, 2),
			"failed",
			["booking.nordwind.de"],
			[0, 2],
		),
		service(
			e("booking", "production"),
			"postgres",
			"postgres",
			db("postgres", "16.10"),
			"running",
		),
		service(
			e("booking", "production"),
			"search",
			"search",
			app({ type: "image", image: "getmeili/meilisearch:v1.16" }, 7700),
			"running",
		),
		service(
			e("booking", "staging"),
			"api",
			"api",
			app(git("gitlab.com/nordwind/booking", "staging"), 8000),
			"running",
			["api-booking.49-12-88-7.sslip.io"],
		),
		service(
			e("rossi", "production"),
			"site",
			"site",
			app(git("github.com/studio-rossi/site"), 80, 1, "static"),
			"running",
			["studiorossi.it"],
		),
		service(
			e("rossi", "production"),
			"cms",
			"cms",
			app({ type: "image", image: "directus/directus:11.12" }, 8055),
			"running",
			["cms.studiorossi.it"],
		),
		service(
			e("rossi", "production"),
			"mariadb",
			"mariadb",
			db("mariadb", "11.8"),
			"running",
		),
		service(
			e("status", "production"),
			"kuma",
			"uptime-kuma",
			app({ type: "image", image: "louislam/uptime-kuma:2.0" }, 3001),
			"running",
			["status.logical.it"],
		),
		service(
			e("analytics", "production"),
			"plausible",
			"plausible",
			app(
				{ type: "image", image: "ghcr.io/plausible/community-edition:v3.1" },
				8000,
			),
			"running",
			["stats.logical.it"],
		),
		service(
			e("analytics", "production"),
			"plausible-db",
			"plausible-db",
			db("postgres", "16.4"),
			"running",
		),
		service(
			e("analytics", "production"),
			"clickhouse",
			"clickhouse",
			app(
				{ type: "image", image: "clickhouse/clickhouse-server:25.8-alpine" },
				8123,
			),
			"running",
		),
		service(
			e("llm-gateway", "staging"),
			"gateway",
			"gateway",
			app(git("github.com/logical-tech/llm-gateway"), 8787, 1, "railpack"),
			"starting",
			[],
			[0, 1],
		),
		service(
			e("llm-gateway", "staging"),
			"redis",
			"redis",
			db("redis", "8.2"),
			"running",
		),
		service(
			e("website", "production"),
			"web",
			"web",
			app(git("github.com/logical-tech/website"), 80, 2, "static"),
			"running",
			["logical.it", "www.logical.it"],
			[2, 2],
		),
		service(
			e("website", "preview"),
			"web-pr-88",
			"web · PR #88",
			app(
				git("github.com/logical-tech/website", "redesign-2026"),
				80,
				1,
				"static",
			),
			"stopped",
			[],
			[0, 0],
		),
		service(
			e("storefront", "production"),
			"media",
			"media",
			storage("minio"),
			"running",
			["s3.acme-retail.it", "console.s3.acme-retail.it"],
		),
		service(
			e("rossi", "production"),
			"uploads",
			"uploads",
			storage("garage"),
			"running",
			["s3.studiorossi.it"],
		),
		service(
			e("analytics", "production"),
			"archive",
			"archive",
			storage("seaweedfs"),
			"running",
		),
		service(
			e("llm-gateway", "staging"),
			"datasets",
			"datasets",
			storage("rustfs"),
			"running",
		),
	];

	const plausible = "stk_analytics_plausible";
	for (const s of services)
		if (
			s.environmentId === e("analytics", "production") &&
			["plausible", "plausible-db", "clickhouse"].includes(s.slug)
		)
			s.stackId = plausible;
	const stacks: MockStack[] = [
		{
			id: plausible,
			environmentId: e("analytics", "production"),
			name: "plausible",
			source: "compose",
			templateId: null,
			createdBy: null,
			createdAt: ago(60 * 24 * 30),
			updatedAt: ago(60 * 24 * 30),
			composeHidden: false,
			composeYaml: PLAUSIBLE_COMPOSE,
		},
	];

	const byId = (id: string) => {
		const s = services.find((x) => x.id === id);
		if (!s) throw new Error(`fixture service ${id} missing`);
		return s.id;
	};

	const latest: Deployment[] = [
		deploy(
			byId("svc_storefront_production_web"),
			"deploying",
			1,
			null,
			"git_push",
			["8f3c2a1", "Gift card balance on checkout summary"],
		),
		deploy(
			byId("svc_booking_production_api"),
			"failed",
			14,
			212,
			"git_push",
			["c41e9b0", "Bump pydantic to 2.12"],
			"Health check failed: GET /healthz returned 500 after 3 attempts",
		),
		deploy(
			byId("svc_llm-gateway_staging_gateway"),
			"building",
			4,
			null,
			"manual",
			["2b77d10", "Per-key monthly budgets"],
		),
		deploy(
			byId("svc_storefront_production_api"),
			"healthy",
			38,
			96,
			"git_push",
			["e09a4f2", "Cache category tree for 60s"],
		),
		deploy(byId("svc_rossi_production_site"), "healthy", 72, 41, "webhook", [
			"5d1a7c3",
			"New project: Villa Bellavista",
		]),
		deploy(
			byId("svc_storefront_staging_api"),
			"deploying",
			2,
			null,
			"git_push",
			["a7f3e11", "Rate-limit coupon endpoint"],
		),
		deploy(
			byId("svc_backoffice_production_app"),
			"healthy",
			190,
			128,
			"manual",
			["91b0c5e", "Returns: refund to original payment"],
		),
		deploy(
			byId("svc_status_production_kuma"),
			"healthy",
			260,
			22,
			"schedule",
			null,
		),
		deploy(
			byId("svc_storefront_production_worker"),
			"healthy",
			300,
			87,
			"git_push",
			["3e8d0aa", "Retry webhook deliveries with jitter"],
		),
		deploy(
			byId("svc_website_production_web"),
			"cancelled",
			410,
			19,
			"git_push",
			["77c2d9f", "WIP hero copy"],
		),
		deploy(byId("svc_booking_staging_api"), "healthy", 520, 188, "git_push", [
			"c41e9b0",
			"Bump pydantic to 2.12",
		]),
		deploy(
			byId("svc_analytics_production_clickhouse"),
			"healthy",
			1440,
			35,
			"manual",
			null,
		),
	];
	// A trigger held back by a skip marker: listed, never run.
	Object.assign(
		deploy(
			byId("svc_storefront_production_web"),
			"skipped",
			25,
			0,
			"git_push",
			["a7d04e2", "docs: tidy the README [skip ci]"],
		),
		{ startedAt: null, reason: "Commit message contains [skip ci]" },
	);
	for (const d of latest) {
		const s = services.find((x) => x.id === d.serviceId);
		if (s) s.latestDeployment = d;
	}
	for (const s of services) {
		if (!s.latestDeployment) {
			s.latestDeployment = deploy(
				s.id,
				"healthy",
				1440 * 3 + s.name.length * 60,
				64,
				"git_push",
				["4c2f8e1", "Initial deploy"],
			);
		}
	}

	const certificates: CertificateSummary[] = [
		{
			id: "crt_booking",
			name: "booking.nordwind.de",
			source: "letsencrypt",
			notAfter: ahead(6),
		},
		{
			id: "crt_acme_wild",
			name: "*.acme-retail.it",
			source: "custom",
			notAfter: ahead(11),
		},
		{
			id: "crt_rossi",
			name: "cms.studiorossi.it",
			source: "letsencrypt",
			notAfter: ahead(24),
		},
	];

	return {
		folders,
		stacks,
		projects,
		environments,
		services,
		deployments,
		certificates,
		backupRuns: [
			{
				id: "bkr_ch_0311",
				status: "failed",
				kind: "backup",
				startedAt: ago(205),
				finishedAt: ago(201),
				error:
					"S3 upload failed: 403 SignatureDoesNotMatch (r2.cloudflarestorage.com)",
			},
			{
				id: "bkr_pg_0311",
				status: "failed",
				kind: "verify",
				startedAt: ago(380),
				finishedAt: ago(371),
				error: 'Restore test: pg_restore exited 1, relation "quotes" missing',
			},
		],
		backupServiceIds: {
			bkr_ch_0311: byId("svc_analytics_production_clickhouse"),
			bkr_pg_0311: byId("svc_booking_production_postgres"),
		},
		setupCompleted: true,
		publicIp: "49.12.88.7",
	};
}
