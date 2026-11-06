import { DockerError } from "./errors.ts";
import { registryAuthHeader } from "./labels.ts";
import { demux, type Frame, jsonLines, rawFrames } from "./stream.ts";
import {
	createTransport,
	type Query,
	type RequestOptions,
} from "./transport.ts";
import type {
	ConfigSpec,
	ContainerCreateRequest,
	ContainerInspect,
	ContainerRestartPolicy,
	ContainerStats,
	ContainerSummary,
	DistributionInspect,
	DockerEvent,
	ExecInspect,
	Filters,
	IdResponse,
	ImageInspect,
	Network,
	NetworkCreateRequest,
	NodeSpec,
	PathStat,
	PruneResponse,
	RegistryAuth,
	SecretSpec,
	Service,
	ServiceCreateResponse,
	ServiceSpec,
	ServiceUpdateResponse,
	Swarm,
	SwarmConfig,
	SwarmInitRequest,
	SwarmNode,
	SwarmSecret,
	SystemDf,
	SystemInfo,
	Task,
	VersionInfo,
	Volume,
	VolumeCreateRequest,
} from "./types.ts";

export interface DockerClientOptions {
	/** Defaults to `$DOCKER_SOCKET`, then `/var/run/docker.sock`. */
	socketPath?: string;
	/** Engine API version pinned in every path. */
	apiVersion?: string;
}

export interface LogOptions {
	follow?: boolean;
	stdout?: boolean;
	stderr?: boolean;
	/** Unix seconds. */
	since?: number;
	timestamps?: boolean;
	tail?: number | "all";
	signal?: AbortSignal;
}

export interface ExecOptions {
	cmd: string[];
	tty?: boolean;
	/** Attach stdin. Defaults to true. */
	stdin?: boolean;
	env?: string[];
	user?: string;
	workingDir?: string;
	signal?: AbortSignal;
}

export interface ExecSession {
	id: string;
	output: ReadableStream<Frame>;
	write(data: string | Uint8Array): Promise<void>;
	closeStdin(): Promise<void>;
	/** TTY sessions only. */
	resize(size: { rows: number; cols: number }): Promise<void>;
	/** Waits for the output to end, then reads the exit code. */
	exitCode(): Promise<number | null>;
	close(): void;
}

export interface PullProgress {
	status?: string;
	id?: string;
	progress?: string;
	error?: string;
	errorDetail?: { message: string };
}

export type DockerClient = ReturnType<typeof createDockerClient>;

export function createDockerClient(opts: DockerClientOptions = {}) {
	const socketPath =
		opts.socketPath ?? process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
	const t = createTransport(socketPath, opts.apiVersion ?? "1.47");
	const get = <T>(path: string, query?: Query) =>
		t.json<T>("GET", path, { query });
	const post = <T>(
		path: string,
		body?: unknown,
		extra: Omit<RequestOptions, "body"> = {},
	) => t.json<T>("POST", path, { ...extra, body });
	const del = (path: string, query?: Query) =>
		t.json<void>("DELETE", path, { query });
	const auth = (a?: RegistryAuth) =>
		a ? { "x-registry-auth": registryAuthHeader(a) } : undefined;
	const id = encodeURIComponent;

	async function logs(
		path: string,
		o: LogOptions,
	): Promise<AsyncGenerator<Frame>> {
		const res = await t.stream("GET", path, {
			query: {
				follow: o.follow ?? false,
				stdout: o.stdout ?? true,
				stderr: o.stderr ?? true,
				since: o.since,
				timestamps: o.timestamps ?? false,
				tail: o.tail === undefined ? undefined : String(o.tail),
			},
			signal: o.signal,
		});
		const body = res.body as ReadableStream<Uint8Array>;
		// TTY containers/services send a raw stream; everything else is multiplexed.
		const multiplexed =
			res.headers.get("content-type")?.includes("multiplexed") ?? true;
		return multiplexed ? demux(body) : rawFrames(body);
	}

	async function* jsonStream<T>(
		method: string,
		path: string,
		o: RequestOptions,
	): AsyncGenerator<T> {
		const res = await t.stream(method, path, o);
		yield* jsonLines<T>(res.body as ReadableStream<Uint8Array>);
	}

	const toBase64 = (data: Uint8Array | string) =>
		Buffer.from(
			typeof data === "string" ? new TextEncoder().encode(data) : data,
		).toString("base64");

	return {
		ping: async () => (await t.stream("GET", "/_ping")).text(),
		info: () => get<SystemInfo>("/info"),
		version: () => get<VersionInfo>("/version"),
		/** Can take seconds on hosts with many volumes: the engine walks each one. */
		df: () => get<SystemDf>("/system/df"),
		prune: {
			containers: (filters?: Filters) =>
				post<PruneResponse>("/containers/prune", undefined, {
					query: { filters },
				}),
			/** `dangling: ["false"]` removes every unused image, not only untagged ones. */
			images: (filters?: Filters) =>
				post<PruneResponse>("/images/prune", undefined, {
					query: { filters },
				}),
			build: (query: { all?: boolean; filters?: Filters } = {}) =>
				post<PruneResponse>("/build/prune", undefined, { query }),
		},

		swarm: {
			inspect: () => get<Swarm>("/swarm"),
			init: (req: SwarmInitRequest) => post<string>("/swarm/init", req),
			joinTokens: async () => (await get<Swarm>("/swarm")).JoinTokens,
		},

		nodes: {
			list: (filters?: Filters) => get<SwarmNode[]>("/nodes", { filters }),
			inspect: (nodeId: string) => get<SwarmNode>(`/nodes/${id(nodeId)}`),
			/** Full-spec replace; `version` must be the current `Version.Index`. */
			update: (nodeId: string, version: number, spec: NodeSpec) =>
				post<void>(`/nodes/${id(nodeId)}/update`, spec, { query: { version } }),
			remove: (nodeId: string, force = false) =>
				del(`/nodes/${id(nodeId)}`, { force }),
		},

		services: {
			create: (spec: ServiceSpec, registryAuth?: RegistryAuth) =>
				post<ServiceCreateResponse>("/services/create", spec, {
					headers: auth(registryAuth),
				}),
			inspect: (serviceId: string) =>
				get<Service>(`/services/${id(serviceId)}`),
			/** Full-spec replace; throws `DockerVersionConflictError` when `version` is stale. */
			update: (
				serviceId: string,
				version: number,
				spec: ServiceSpec,
				o: { registryAuth?: RegistryAuth; rollback?: boolean } = {},
			) =>
				post<ServiceUpdateResponse>(`/services/${id(serviceId)}/update`, spec, {
					query: { version, rollback: o.rollback ? "previous" : undefined },
					headers: auth(o.registryAuth),
				}),
			remove: (serviceId: string) => del(`/services/${id(serviceId)}`),
			list: (filters?: Filters) =>
				get<Service[]>("/services", { filters, status: true }),
			logs: (serviceId: string, o: LogOptions = {}) =>
				logs(`/services/${id(serviceId)}/logs`, o),
		},

		tasks: {
			list: (filters?: Filters) => get<Task[]>("/tasks", { filters }),
		},

		containers: {
			list: (filters?: Filters, all = false) =>
				get<ContainerSummary[]>("/containers/json", { filters, all }),
			inspect: (containerId: string) =>
				get<ContainerInspect>(`/containers/${id(containerId)}/json`),
			create: (name: string, req: ContainerCreateRequest) =>
				post<{ Id: string; Warnings: string[] }>("/containers/create", req, {
					query: { name },
				}),
			start: (containerId: string) =>
				post<void>(`/containers/${id(containerId)}/start`),
			/** Waits up to `timeoutS` for a clean exit, then kills. A stopped container is a no-op (304). */
			stop: (containerId: string, timeoutS = 10) =>
				post<void>(`/containers/${id(containerId)}/stop`, undefined, {
					query: { t: String(timeoutS) },
				}),
			remove: (containerId: string, force = false) =>
				del(`/containers/${id(containerId)}`, { force }),
			/** Changes a running or stopped container's restart policy. */
			setRestartPolicy: (containerId: string, policy: ContainerRestartPolicy) =>
				post<unknown>(`/containers/${id(containerId)}/update`, {
					RestartPolicy: policy,
				}),
			/** A tar of `path` inside the container, read by the daemon (as root), stopped or not. */
			archive: async (containerId: string, path: string) =>
				new Uint8Array(
					await (
						await t.stream("GET", `/containers/${id(containerId)}/archive`, {
							query: { path },
						})
					).arrayBuffer(),
				),
			/** Streaming form of `archive`; aborting `signal` stops the daemon's walk. */
			archiveStream: async (
				containerId: string,
				path: string,
				signal?: AbortSignal,
			) =>
				(
					await t.stream("GET", `/containers/${id(containerId)}/archive`, {
						query: { path },
						signal,
					})
				).body as ReadableStream<Uint8Array>,
			/** `path` itself, symlinks not followed; parent components resolve inside the container root. */
			statPath: async (containerId: string, path: string) => {
				const res = await t.stream(
					"HEAD",
					`/containers/${id(containerId)}/archive`,
					{ query: { path } },
				);
				const raw = res.headers.get("x-docker-container-path-stat");
				if (!raw) throw new Error("the engine sent no path stat");
				return JSON.parse(Buffer.from(raw, "base64").toString()) as PathStat;
			},
			/** Extracts `tar` into the existing directory `path`; never swaps a directory for a file or back. */
			putArchive: (containerId: string, path: string, tar: Uint8Array) =>
				t.json<void>("PUT", `/containers/${id(containerId)}/archive`, {
					query: { path, noOverwriteDirNonDir: true },
					headers: { "content-type": "application/x-tar" },
					body: tar,
				}),
			logs: (containerId: string, o: LogOptions = {}) =>
				logs(`/containers/${id(containerId)}/logs`, o),
			stats: (containerId: string) =>
				get<ContainerStats>(`/containers/${id(containerId)}/stats`, {
					stream: false,
					"one-shot": true,
				}),
			statsStream: (containerId: string, signal?: AbortSignal) =>
				jsonStream<ContainerStats>(
					"GET",
					`/containers/${id(containerId)}/stats`,
					{
						query: { stream: true },
						signal,
					},
				),
			async exec(containerId: string, o: ExecOptions): Promise<ExecSession> {
				const tty = o.tty ?? false;
				const created = await post<{ Id: string }>(
					`/containers/${id(containerId)}/exec`,
					{
						AttachStdin: o.stdin ?? true,
						AttachStdout: true,
						AttachStderr: true,
						Tty: tty,
						Cmd: o.cmd,
						Env: o.env,
						User: o.user,
						WorkingDir: o.workingDir,
					},
				);
				const execId = created.Id;
				const s = await t.hijack(
					`/exec/${id(execId)}/start`,
					{ Detach: false, Tty: tty },
					o.signal,
				);
				return {
					id: execId,
					output: s.output,
					write: s.write,
					closeStdin: s.closeStdin,
					close: s.close,
					resize: ({ rows, cols }) =>
						post<void>(`/exec/${id(execId)}/resize`, undefined, {
							query: { h: rows, w: cols },
						}),
					async exitCode() {
						await s.closed;
						// The engine can report Running for a moment after the stream closes.
						for (let i = 0; i < 20; i++) {
							const info = await get<ExecInspect>(`/exec/${id(execId)}/json`);
							if (!info.Running) return info.ExitCode;
							await Bun.sleep(50);
						}
						throw new DockerError(
							0,
							"exec still running after its stream closed",
							"GET",
							`/exec/${execId}/json`,
						);
					},
				};
			},
		},

		networks: {
			create: (req: NetworkCreateRequest) =>
				post<{ Id: string; Warning?: string }>("/networks/create", req),
			inspect: (networkId: string) =>
				get<Network>(`/networks/${id(networkId)}`),
			list: (filters?: Filters) => get<Network[]>("/networks", { filters }),
			remove: (networkId: string) => del(`/networks/${id(networkId)}`),
			connect: (networkId: string, containerId: string, aliases?: string[]) =>
				post<void>(`/networks/${id(networkId)}/connect`, {
					Container: containerId,
					EndpointConfig: aliases ? { Aliases: aliases } : undefined,
				}),
			disconnect: (networkId: string, containerId: string, force = false) =>
				post<void>(`/networks/${id(networkId)}/disconnect`, {
					Container: containerId,
					Force: force,
				}),
		},

		volumes: {
			create: (req: VolumeCreateRequest) =>
				post<Volume>("/volumes/create", req),
			list: async (filters?: Filters) =>
				(await get<{ Volumes: Volume[] | null }>("/volumes", { filters }))
					.Volumes ?? [],
			remove: (name: string, force = false) =>
				del(`/volumes/${id(name)}`, { force }),
		},

		configs: {
			create: (spec: ConfigSpec) =>
				post<IdResponse>("/configs/create", {
					...spec,
					Data: toBase64(spec.Data),
				}),
			list: (filters?: Filters) => get<SwarmConfig[]>("/configs", { filters }),
			remove: (configId: string) => del(`/configs/${id(configId)}`),
		},

		secrets: {
			create: (spec: SecretSpec) =>
				post<IdResponse>("/secrets/create", {
					...spec,
					Data: toBase64(spec.Data),
				}),
			list: (filters?: Filters) => get<SwarmSecret[]>("/secrets", { filters }),
			remove: (secretId: string) => del(`/secrets/${id(secretId)}`),
		},

		images: {
			/** Resolves when the pull finishes; an error reported mid-stream rejects with `DockerError`. */
			async pull(
				ref: string,
				o: {
					registryAuth?: RegistryAuth;
					signal?: AbortSignal;
					onProgress?: (p: PullProgress) => void;
				} = {},
			): Promise<void> {
				const path = "/images/create";
				for await (const p of jsonStream<PullProgress>("POST", path, {
					query: { fromImage: ref },
					headers: auth(o.registryAuth),
					signal: o.signal,
				})) {
					if (p.error)
						throw new DockerError(
							500,
							p.errorDetail?.message ?? p.error,
							"POST",
							path,
						);
					o.onProgress?.(p);
				}
			},
			inspect: (ref: string) => get<ImageInspect>(`/images/${id(ref)}/json`),
			/** Asks the registry about `ref` without pulling it; rejects when the tag does not exist. */
			distribution: (ref: string) =>
				get<DistributionInspect>(`/distribution/${id(ref)}/json`),
			remove: (ref: string, force = false) =>
				t.json<{ Untagged?: string; Deleted?: string }[]>(
					"DELETE",
					`/images/${id(ref)}`,
					{ query: { force } },
				),
		},

		/** Live event stream; ends when `signal` aborts (the iterator then throws AbortError). */
		events: (
			o: {
				filters?: Filters;
				since?: number;
				until?: number;
				signal?: AbortSignal;
			} = {},
		) =>
			jsonStream<DockerEvent>("GET", "/events", {
				query: { filters: o.filters, since: o.since, until: o.until },
				signal: o.signal,
			}),
	};
}
