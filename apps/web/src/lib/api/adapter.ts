import type { AccessAdapter } from "./access-adapter";
import type { NetworkingApi } from "./networking";
import type { ServiceOpsApi } from "./service-ops";
import type { SsoApi } from "./sso";
import type { StacksApi } from "./stacks";
import type { TemplatesApi } from "./templates";
import type {
	ClusterNode,
	ContainerMetrics,
	CreateEnvironmentInput,
	CreateFolderInput,
	CreateProjectInput,
	CreateServiceInput,
	DiskUsage,
	DnsCheck,
	Environment,
	EnvironmentId,
	Folder,
	GitSource,
	HostMetrics,
	ImageSource,
	InstanceStatus,
	MetricRange,
	MonitoringSettings,
	MonitoringSettingsInput,
	NodeId,
	NodeJoin,
	NodeJoinInput,
	NodeJoinStep,
	NodeUpdate,
	OrganizationUsage,
	Overview,
	Project,
	ProjectDetail,
	ProjectId,
	ProjectSummary,
	ProjectUsage,
	PruneInput,
	PruneResult,
	Service,
	ServiceId,
	SetupInput,
	SourceCheck,
	UsageRange,
} from "./types";

/**
 * The one seam between the UI and the server. `http.ts` implements it against
 * the REST API; `mock/` implements it in memory for VITE_API_MOCK=1.
 */
export type ApiAdapter = {
	access: AccessAdapter;
	instance: {
		status(): Promise<InstanceStatus>;
		/** `setupToken`: what install.sh --public-setup printed; empty when the server needs none. */
		checkDns(hostname: string, setupToken: string): Promise<DnsCheck>;
		completeSetup(input: SetupInput, setupToken: string): Promise<void>;
		version(): Promise<{ version: string; commit?: string }>;
	};
	overview: {
		get(): Promise<Overview>;
	};
	folders: {
		list(): Promise<Folder[]>;
		create(input: CreateFolderInput): Promise<Folder>;
	};
	projects: {
		list(): Promise<ProjectSummary[]>;
		get(id: ProjectId): Promise<ProjectDetail>;
		create(input: CreateProjectInput): Promise<Project>;
		createEnvironment(
			id: ProjectId,
			input: CreateEnvironmentInput,
		): Promise<Environment>;
	};
	services: {
		listByEnvironment(environmentId: EnvironmentId): Promise<Service[]>;
		create(input: CreateServiceInput): Promise<{ id: ServiceId }>;
		checkSource(source: GitSource | ImageSource): Promise<SourceCheck>;
	};
	nodes: {
		list(): Promise<ClusterNode[]>;
		get(id: NodeId): Promise<ClusterNode>;
		update(id: NodeId, input: NodeUpdate): Promise<ClusterNode>;
		/** Drains, leaves the swarm, then deletes the node; returns at once. */
		remove(id: NodeId): Promise<ClusterNode>;
		/** Asks the node's agent; takes seconds on hosts with many volumes. */
		disk(id: NodeId): Promise<DiskUsage>;
		prune(id: NodeId, input: PruneInput): Promise<PruneResult>;
	};
	joins: {
		/** Creates the Add-server run and queues its SSH test. */
		create(input: NodeJoinInput): Promise<NodeJoin>;
		get(id: string): Promise<NodeJoin>;
		/** New connection details; restarts from the SSH test. */
		update(id: string, input: NodeJoinInput): Promise<NodeJoin>;
		run(id: string, step: NodeJoinStep): Promise<NodeJoin>;
	};
	metrics: {
		hosts(query: {
			range: MetricRange;
			nodeId?: NodeId;
			perNode?: boolean;
		}): Promise<HostMetrics>;
		service(id: ServiceId, range: MetricRange): Promise<ContainerMetrics>;
		/** Only the projects the caller can read. */
		usage(range: UsageRange): Promise<OrganizationUsage>;
		projectUsage(id: ProjectId, range: UsageRange): Promise<ProjectUsage>;
	};
	monitoring: {
		settings(): Promise<MonitoringSettings>;
		save(input: MonitoringSettingsInput): Promise<MonitoringSettings>;
	};
	networking: NetworkingApi;
	serviceOps: ServiceOpsApi;
	sso: SsoApi;
	stacks: StacksApi;
	templates: TemplatesApi;
};

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code?: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ApiError";
	}
}
