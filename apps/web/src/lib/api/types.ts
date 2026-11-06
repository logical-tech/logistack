/*
 * Wire shapes of the LogiStack REST API. Everything the server serves is inferred from
 * its routes through the typed Hono client, so a server change breaks this build instead
 * of the running UI. Only views the server has no endpoint for yet are written by hand.
 */
import type {
	ApplicationSource,
	BuildConfig,
	ObservedState,
	ServiceSpec,
} from "@logistack/contracts";
import type { InferRequestType, InferResponseType } from "hono/client";
import type { client } from "./client";

export type {
	DatabaseEngine,
	DeploymentStatus,
	DeploymentTrigger,
	DnsProviderKind,
	EnvironmentKind,
	GeneratedDomainBase,
	MetricRange,
	NodeJoinStep,
	NodeRole,
	NodeStatus,
	ServiceKind,
	ServiceSpec,
	ServiceThresholdMetric,
	ThresholdMetric,
	UsageRange,
} from "@logistack/contracts";

export type ObservedStatus = ObservedState;
export type GitSource = Extract<ApplicationSource, { type: "git" }>;
export type ImageSource = Extract<ApplicationSource, { type: "image" }>;
export type BuildType = BuildConfig["type"];

type Api = typeof client.api;
type Ok<F> = InferResponseType<F, 200>;
type Body<F> = InferRequestType<F> extends { json: infer J } ? J : never;

export type InstanceStatus = Ok<Api["setup"]["status"]["$get"]>;
export type SetupInput = Body<Api["setup"]["$post"]>;
export type DnsCheck = Ok<Api["setup"]["dns-check"]["$post"]>;

export type Folder = Omit<Ok<Api["folders"]["$get"]>[number], "children">;
export type ProjectSummary = Ok<Api["projects"]["$get"]>[number];
export type Project = Ok<Api["projects"][":id"]["$get"]>;
export type Environment = Ok<
	Api["projects"][":id"]["environments"]["$get"]
>[number];
export type ProjectDetail = Project & { environments: Environment[] };
export type Service = Ok<
	Api["environments"][":id"]["services"]["$get"]
>[number];
export type Deployment = NonNullable<Service["latestDeployment"]>;
export type DeploymentListItem = Ok<
	Api["home"]["summary"]["$get"]
>["recentDeployments"][number];
export type SourceCheck = Ok<Api["services"]["check-source"]["$post"]>;

export type FolderId = Folder["id"];
export type ProjectId = Project["id"];
export type EnvironmentId = Environment["id"];
export type ServiceId = Service["id"];

export type CreateFolderInput = Body<Api["folders"]["$post"]>;
export type CreateProjectInput = Body<Api["projects"]["$post"]>;
export type CreateEnvironmentInput = Body<
	Api["projects"][":id"]["environments"]["$post"]
>;
export type UpdateEnvironmentInput = Body<Api["environments"][":id"]["$patch"]>;
export type EnvironmentColor = NonNullable<Environment["color"]>;
/** One wizard submit: the service, its domain, then its first deployment. */
export type CreateServiceInput = {
	environmentId: EnvironmentId;
	name: string;
	spec: ServiceSpec;
	/** `generated` asks the server for an sslip.io / nip.io / wildcard hostname. */
	domain: DomainInput | null;
	/** More domains on other ports, like an object storage console. */
	extraDomains?: DomainInput[];
	/** Config files and named volumes, e.g. a web server preset's. */
	mounts?: Body<Api["environments"][":id"]["services"]["$post"]>["mounts"];
	/** Provenance marker, e.g. `webserver:nginx`. */
	importedFrom?: string;
	/** Profile the spec's limits came from; null opts out of the organization default. */
	resourceProfile?: string | null;
};
export type DomainInput =
	| { kind: "generated"; port: number }
	| { kind: "custom"; hostname: string; port: number; https: boolean };

/** A service reduced to what list views draw: its name and observed status. */
export type ServiceSignal = ProjectSummary["services"][number];

export type ClusterNode = Ok<Api["nodes"]["$get"]>[number];
export type NodeId = ClusterNode["id"];
export type NodeUpdate = Body<Api["nodes"][":id"]["$patch"]>;
export type LiveHostSample = NonNullable<ClusterNode["live"]>;
export type DiskUsage = Ok<Api["nodes"][":id"]["disk"]["$get"]>;
export type HostDirs = Ok<Api["nodes"][":id"]["host-dirs"]["$get"]>;
export type PruneInput = Body<Api["nodes"][":id"]["disk"]["prune"]["$post"]>;
export type PruneResult = Ok<Api["nodes"][":id"]["disk"]["prune"]["$post"]>;
export type PruneTarget = PruneInput["targets"][number];

export type HostMetrics = Ok<Api["metrics"]["hosts"]["$get"]>;
export type HostSeries = HostMetrics["series"][number];
export type HostPoint = HostSeries["points"][number];
export type ContainerMetrics = Ok<Api["metrics"]["services"][":id"]["$get"]>;
export type ContainerPoint = ContainerMetrics["points"][number];
export type OrganizationUsage = Ok<Api["usage"]["$get"]>;
export type ProjectUsage = Ok<Api["projects"][":id"]["usage"]["$get"]>;
export type UsageFigures = OrganizationUsage["totals"];
export type UsagePoint = OrganizationUsage["trend"][number];

export type MonitoringSettings = Ok<Api["monitoring"]["settings"]["$get"]>;
export type MonitoringSettingsInput = Body<
	Api["monitoring"]["settings"]["$put"]
>;
export type Threshold = MonitoringSettings["thresholds"][number];
export type ServiceThreshold = MonitoringSettings["serviceThresholds"][number];
export type ServiceThresholdsInput = Body<
	Api["services"][":id"]["thresholds"]["$put"]
>;

export type NodeJoin = Ok<Api["nodes"]["joins"][":id"]["$get"]>;
export type NodeJoinInput = Body<Api["nodes"]["joins"]["$post"]>;
export type PreflightCheck = NodeJoin["checks"][number];

/** Home sections with no endpoint yet: certificates and backups (empty over HTTP). */
// shortcut: hand-written until the server has certificate and backup endpoints.
export type CertificateSummary = {
	id: string;
	name: string;
	source: "letsencrypt" | "custom";
	notAfter: string;
};

export type BackupRunListItem = {
	id: string;
	status: "running" | "succeeded" | "failed";
	kind: "backup" | "verify" | "restore";
	startedAt: string;
	finishedAt: string | null;
	error: string | null;
	service: { id: ServiceId; name: string };
	project: { id: ProjectId; name: string };
};

/** Home: the server's summary plus the panels whose endpoints don't exist yet (empty over HTTP). */
export type Overview = {
	projectCount: number;
	servicesByStatus: Record<ObservedStatus, number>;
	recentDeployments: DeploymentListItem[];
	failedBackups: BackupRunListItem[];
	expiringCertificates: CertificateSummary[];
};
