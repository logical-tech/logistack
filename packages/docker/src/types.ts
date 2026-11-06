// Hand-written subset of the Docker Engine API (v1.47) that LogiStack uses.
// Field names match the wire format so specs serialize without mapping.

export type Labels = Record<string, string>;

/** Engine API durations are integer nanoseconds. */
export type Nanoseconds = number;

export interface ObjectVersion {
	Index: number;
}

export interface Meta {
	ID: string;
	Version: ObjectVersion;
	CreatedAt: string;
	UpdatedAt: string;
}

// ---- System ----

export interface VersionInfo {
	Version: string;
	ApiVersion: string;
	MinAPIVersion: string;
	Os: string;
	Arch: string;
	KernelVersion: string;
}

export interface SystemInfo {
	ID: string;
	Name: string;
	ServerVersion: string;
	NCPU: number;
	MemTotal: number;
	Containers: number;
	Images: number;
	DockerRootDir: string;
	Swarm: {
		NodeID: string;
		NodeAddr: string;
		LocalNodeState: "inactive" | "pending" | "active" | "error" | "locked";
		ControlAvailable: boolean;
		Error: string;
	};
}

// ---- Swarm ----

export interface SwarmSpec {
	Name?: string;
	Labels?: Labels;
	Orchestration?: { TaskHistoryRetentionLimit?: number };
	Raft?: Record<string, unknown>;
	Dispatcher?: { HeartbeatPeriod?: Nanoseconds };
	CAConfig?: Record<string, unknown>;
	EncryptionConfig?: { AutoLockManagers?: boolean };
	TaskDefaults?: Record<string, unknown>;
}

export interface Swarm extends Meta {
	Spec: SwarmSpec;
	JoinTokens: { Worker: string; Manager: string };
}

export interface SwarmInitRequest {
	ListenAddr: string;
	AdvertiseAddr: string;
	DataPathAddr?: string;
	DefaultAddrPool?: string[];
	SubnetSize?: number;
	ForceNewCluster?: boolean;
	Spec?: SwarmSpec;
}

// ---- Nodes ----

export interface NodeSpec {
	Name?: string;
	Labels?: Labels;
	Role: "worker" | "manager";
	Availability: "active" | "pause" | "drain";
}

export interface SwarmNode extends Meta {
	Spec: NodeSpec;
	Description: {
		Hostname: string;
		Platform: { Architecture: string; OS: string };
		Resources: { NanoCPUs: number; MemoryBytes: number };
		Engine: { EngineVersion: string; Labels?: Labels };
	};
	Status: {
		State: "unknown" | "down" | "ready" | "disconnected";
		Message?: string;
		Addr: string;
	};
	ManagerStatus?: { Leader?: boolean; Reachability: string; Addr: string };
}

// ---- Services ----

export interface Healthcheck {
	/** ["CMD", ...argv] or ["CMD-SHELL", script] or ["NONE"]. */
	Test: string[];
	Interval?: Nanoseconds;
	Timeout?: Nanoseconds;
	Retries?: number;
	StartPeriod?: Nanoseconds;
	StartInterval?: Nanoseconds;
}

export type Mount =
	| {
			Type: "volume";
			Source: string;
			Target: string;
			ReadOnly?: boolean;
			VolumeOptions?: {
				NoCopy?: boolean;
				Labels?: Labels;
				DriverConfig?: { Name?: string; Options?: Record<string, string> };
			};
	  }
	| {
			Type: "bind";
			Source: string;
			Target: string;
			ReadOnly?: boolean;
			BindOptions?: { Propagation?: string; CreateMountpoint?: boolean };
	  }
	| {
			Type: "tmpfs";
			Target: string;
			TmpfsOptions?: { SizeBytes?: number; Mode?: number };
	  };

export interface FileReference {
	/** Target path inside the container is `File.Name` (absolute paths allowed). */
	File: { Name: string; UID: string; GID: string; Mode: number };
}

export interface ConfigReference extends FileReference {
	ConfigID: string;
	ConfigName: string;
}

export interface SecretReference extends FileReference {
	SecretID: string;
	SecretName: string;
}

export interface ContainerSpec {
	Image: string;
	Labels?: Labels;
	Command?: string[];
	Args?: string[];
	Hostname?: string;
	Env?: string[];
	Dir?: string;
	User?: string;
	Mounts?: Mount[];
	StopSignal?: string;
	StopGracePeriod?: Nanoseconds;
	Healthcheck?: Healthcheck;
	Configs?: ConfigReference[];
	Secrets?: SecretReference[];
	Init?: boolean;
	TTY?: boolean;
	OpenStdin?: boolean;
	ReadOnly?: boolean;
	Sysctls?: Record<string, string>;
	CapabilityAdd?: string[];
	CapabilityDrop?: string[];
	Ulimits?: { Name: string; Soft: number; Hard: number }[];
}

export interface ResourceLimits {
	NanoCPUs?: number;
	MemoryBytes?: number;
	Pids?: number;
}

export interface Resources {
	Limits?: ResourceLimits;
	Reservations?: { NanoCPUs?: number; MemoryBytes?: number };
}

export interface Placement {
	Constraints?: string[];
	Preferences?: { Spread: { SpreadDescriptor: string } }[];
	MaxReplicas?: number;
	/** Image platforms; Swarm maps `amd64`/`arm64` to node `x86_64`/`aarch64`. */
	Platforms?: { Architecture: string; OS: string }[];
}

export interface RestartPolicy {
	Condition?: "none" | "on-failure" | "any";
	Delay?: Nanoseconds;
	MaxAttempts?: number;
	Window?: Nanoseconds;
}

export interface NetworkAttachment {
	Target: string;
	Aliases?: string[];
	DriverOpts?: Record<string, string>;
}

export interface LogDriver {
	Name: string;
	Options?: Record<string, string>;
}

export interface TaskSpec {
	ContainerSpec: ContainerSpec;
	Resources?: Resources;
	RestartPolicy?: RestartPolicy;
	Placement?: Placement;
	Networks?: NetworkAttachment[];
	LogDriver?: LogDriver;
	/** Bump to force a redeploy with an otherwise identical spec. */
	ForceUpdate?: number;
}

export interface UpdateConfig {
	Parallelism?: number;
	Delay?: Nanoseconds;
	FailureAction?: "continue" | "pause" | "rollback";
	Monitor?: Nanoseconds;
	MaxFailureRatio?: number;
	Order?: "stop-first" | "start-first";
}

export type RollbackConfig = Omit<UpdateConfig, "FailureAction"> & {
	FailureAction?: "continue" | "pause";
};

export interface PortConfig {
	Name?: string;
	Protocol?: "tcp" | "udp" | "sctp";
	TargetPort: number;
	PublishedPort?: number;
	PublishMode?: "ingress" | "host";
}

export interface EndpointSpec {
	Mode?: "vip" | "dnsrr";
	Ports?: PortConfig[];
}

export type ServiceMode =
	| { Replicated: { Replicas: number } }
	| { Global: Record<string, never> }
	| { ReplicatedJob: { MaxConcurrent?: number; TotalCompletions?: number } }
	| { GlobalJob: Record<string, never> };

export interface ServiceSpec {
	Name: string;
	Labels?: Labels;
	TaskTemplate: TaskSpec;
	Mode?: ServiceMode;
	UpdateConfig?: UpdateConfig;
	RollbackConfig?: RollbackConfig;
	EndpointSpec?: EndpointSpec;
}

export type UpdateState =
	| "updating"
	| "paused"
	| "completed"
	| "rollback_started"
	| "rollback_paused"
	| "rollback_completed";

export interface UpdateStatus {
	State: UpdateState;
	StartedAt?: string;
	CompletedAt?: string;
	Message?: string;
}

export interface Service extends Meta {
	Spec: ServiceSpec;
	PreviousSpec?: ServiceSpec;
	Endpoint?: {
		Spec: EndpointSpec;
		Ports?: PortConfig[];
		VirtualIPs?: { NetworkID: string; Addr: string }[];
	};
	UpdateStatus?: UpdateStatus;
	ServiceStatus?: {
		RunningTasks: number;
		DesiredTasks: number;
		CompletedTasks: number;
	};
}

export interface ServiceCreateResponse {
	ID: string;
	Warnings?: string[] | null;
}

export interface ServiceUpdateResponse {
	Warnings?: string[] | null;
}

// ---- Tasks ----

export type TaskState =
	| "new"
	| "allocated"
	| "pending"
	| "assigned"
	| "accepted"
	| "preparing"
	| "ready"
	| "starting"
	| "running"
	| "complete"
	| "shutdown"
	| "failed"
	| "rejected"
	| "remove"
	| "orphaned";

export interface Task extends Meta {
	Name?: string;
	Labels?: Labels;
	Spec: TaskSpec;
	ServiceID: string;
	Slot?: number;
	NodeID?: string;
	Status: {
		Timestamp: string;
		State: TaskState;
		Message: string;
		Err?: string;
		ContainerStatus?: { ContainerID?: string; PID?: number; ExitCode?: number };
	};
	DesiredState: TaskState;
}

// ---- Containers ----

export interface ContainerSummary {
	Id: string;
	Names: string[];
	Image: string;
	ImageID: string;
	Command: string;
	Created: number;
	State:
		| "created"
		| "running"
		| "paused"
		| "restarting"
		| "removing"
		| "exited"
		| "dead";
	Status: string;
	Labels: Labels;
}

export interface ContainerInspect {
	Id: string;
	Name: string;
	Created: string;
	Image: string;
	State: {
		Status: ContainerSummary["State"];
		Running: boolean;
		ExitCode: number;
		StartedAt: string;
		FinishedAt: string;
		Health?: {
			Status: "starting" | "healthy" | "unhealthy" | "none";
			FailingStreak: number;
		};
	};
	Config: {
		Image: string;
		Labels: Labels;
		Env: string[] | null;
		Tty: boolean;
		Cmd: string[] | null;
	};
	NetworkSettings: {
		Networks: Record<string, { NetworkID: string; IPAddress: string }>;
	};
	HostConfig: { RestartPolicy: ContainerRestartPolicy };
}

/** A plain container's restart policy (not a Swarm task's). */
export interface ContainerRestartPolicy {
	Name: "" | "no" | "always" | "unless-stopped" | "on-failure";
	MaximumRetryCount?: number;
}

/** Body of POST /containers/create (used by tests and one-off jobs; apps run as services). */
export interface ContainerCreateRequest {
	Image: string;
	Cmd?: string[];
	Entrypoint?: string[];
	Env?: string[];
	Labels?: Labels;
	Tty?: boolean;
	OpenStdin?: boolean;
	WorkingDir?: string;
	User?: string;
	HostConfig?: {
		AutoRemove?: boolean;
		Binds?: string[];
		Mounts?: Mount[];
		NetworkMode?: string;
		Memory?: number;
		NanoCpus?: number;
	};
}

export interface ContainerStats {
	read: string;
	id: string;
	name: string;
	cpu_stats: {
		cpu_usage: { total_usage: number };
		system_cpu_usage?: number;
		online_cpus?: number;
	};
	precpu_stats: ContainerStats["cpu_stats"];
	memory_stats: {
		usage?: number;
		limit?: number;
		stats?: Record<string, number>;
	};
	networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
	pids_stats?: { current?: number };
}

export interface ExecInspect {
	ID: string;
	Running: boolean;
	ExitCode: number | null;
	ContainerID: string;
	Pid: number;
}

// ---- Networks ----

export interface NetworkCreateRequest {
	Name: string;
	Driver?: "overlay" | "bridge";
	Attachable?: boolean;
	Internal?: boolean;
	Scope?: "swarm" | "local";
	Labels?: Labels;
	Options?: Record<string, string>;
	IPAM?: { Driver?: string; Config?: { Subnet?: string; Gateway?: string }[] };
}

export interface Network {
	Id: string;
	Name: string;
	Driver: string;
	Scope: string;
	Attachable: boolean;
	Internal: boolean;
	Labels: Labels;
	Options: Record<string, string>;
}

// ---- Volumes ----

export interface VolumeCreateRequest {
	Name: string;
	Driver?: string;
	DriverOpts?: Record<string, string>;
	Labels?: Labels;
}

export interface Volume {
	Name: string;
	Driver: string;
	Mountpoint: string;
	Labels: Labels | null;
	Scope: "local" | "global";
	Options: Record<string, string> | null;
	CreatedAt?: string;
}

// ---- Disk usage / prune ----

/** `GET /system/df`; the engine fills `UsageData` with -1 when it did not measure. */
export interface SystemDf {
	LayersSize: number;
	Images: {
		Id: string;
		RepoTags: string[] | null;
		Created: number;
		Size: number;
		SharedSize: number;
		Containers: number;
		Labels: Labels | null;
	}[];
	Containers: {
		Id: string;
		Names: string[];
		Image: string;
		State: string;
		SizeRw?: number;
		SizeRootFs?: number;
		Labels: Labels | null;
	}[];
	Volumes: (Volume & {
		UsageData: { Size: number; RefCount: number } | null;
	})[];
	BuildCache: {
		ID: string;
		Type: string;
		InUse: boolean;
		Shared: boolean;
		Size: number;
		LastUsedAt: string | null;
	}[];
}

export interface PruneResponse {
	SpaceReclaimed: number;
	ContainersDeleted?: string[] | null;
	ImagesDeleted?: { Untagged?: string; Deleted?: string }[] | null;
	CachesDeleted?: string[] | null;
}

// ---- Configs / secrets ----

export interface ConfigSpec {
	Name: string;
	Labels?: Labels;
	/** Raw bytes or UTF-8 text; the client base64-encodes it. */
	Data: Uint8Array | string;
}

export interface SecretSpec extends ConfigSpec {
	Driver?: { Name: string; Options?: Record<string, string> };
}

export interface SwarmConfig extends Meta {
	Spec: { Name: string; Labels?: Labels; Data?: string };
}

export interface SwarmSecret extends Meta {
	/** The engine never returns secret data. */
	Spec: { Name: string; Labels?: Labels };
}

// ---- Images ----

export interface ImageInspect {
	Id: string;
	RepoTags: string[];
	RepoDigests: string[];
	Created: string;
	Size: number;
	Config: {
		Healthcheck?: Healthcheck;
		ExposedPorts?: Record<string, object>;
		Labels?: Labels | null;
		Env?: string[] | null;
	};
}

/** `GET /distribution/{ref}/json`: the registry's descriptor for a tag, resolved by the daemon. */
export interface DistributionInspect {
	Descriptor: { mediaType: string; digest: string; size: number };
}

export interface RegistryAuth {
	username: string;
	password: string;
	serveraddress: string;
}

// ---- Events ----

export type EventType =
	| "builder"
	| "config"
	| "container"
	| "daemon"
	| "image"
	| "network"
	| "node"
	| "plugin"
	| "secret"
	| "service"
	| "volume";

export interface DockerEvent {
	Type: EventType;
	Action: string;
	Actor: { ID: string; Attributes: Record<string, string> };
	scope: "local" | "swarm";
	time: number;
	timeNano: number;
}

// ---- Shared ----

/** Engine filter map, e.g. `{ label: ["logistack.managed=true"] }`. */
export type Filters = Record<string, string[]>;

export interface IdResponse {
	ID: string;
}
