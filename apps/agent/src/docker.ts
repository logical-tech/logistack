import type { ContainerMetrics, ContainerTarget } from "@logistack/contracts";
import {
	type ContainerStats,
	type DockerClient,
	type DockerEvent,
	LABEL_MANAGED,
	LABEL_RESOURCE,
} from "@logistack/docker";

export class TargetNotFoundError extends Error {}

const TASK_ID = "com.docker.swarm.task.id";
const SERVICE_ID = "com.docker.swarm.service.id";
const SERVICE_NAME = "com.docker.swarm.service.name";

/** Running container for a Swarm task or service on this node; the local daemon only lists local containers. */
export async function resolveTarget(
	docker: DockerClient,
	target: ContainerTarget,
): Promise<string> {
	const label =
		target.kind === "task"
			? `${TASK_ID}=${target.taskId}`
			: `${SERVICE_ID}=${target.serviceId}`;
	const running = await docker.containers.list({
		label: [label],
		status: ["running"],
	});
	const oldest = running.sort((a, b) => a.Created - b.Created)[0];
	if (!oldest)
		throw new TargetNotFoundError(
			`no running container for ${label} on this node`,
		);
	return oldest.Id;
}

// The engine's stats carry blkio too; the shared client types omit it.
type Stats = ContainerStats & {
	blkio_stats?: {
		io_service_bytes_recursive?: { op: string; value: number }[] | null;
	};
};

export interface CpuPrev {
	container: number;
	system: number;
}

export function containerMetrics(
	c: { Id: string; Names: string[]; Labels: Record<string, string> },
	s: Stats,
	prev: CpuPrev | undefined,
): ContainerMetrics {
	const cpu = s.cpu_stats.cpu_usage.total_usage;
	const system = s.cpu_stats.system_cpu_usage ?? 0;
	const dSystem = prev ? system - prev.system : 0;
	const dCpu = prev ? cpu - prev.container : 0;
	const cpus = s.cpu_stats.online_cpus ?? 1;
	let rxBytes = 0;
	let txBytes = 0;
	for (const n of Object.values(s.networks ?? {})) {
		rxBytes += n.rx_bytes;
		txBytes += n.tx_bytes;
	}
	let readBytes = 0;
	let writeBytes = 0;
	for (const io of s.blkio_stats?.io_service_bytes_recursive ?? []) {
		const op = io.op.toLowerCase();
		if (op === "read") readBytes += io.value;
		else if (op === "write") writeBytes += io.value;
	}
	// Same as `docker stats`: page cache that can be reclaimed is not counted.
	const usage = s.memory_stats.usage ?? 0;
	const cache =
		s.memory_stats.stats?.inactive_file ??
		s.memory_stats.stats?.total_inactive_file ??
		0;
	return {
		containerId: c.Id,
		name: (c.Names[0] ?? c.Id).replace(/^\//, ""),
		taskId: c.Labels[TASK_ID],
		serviceId: c.Labels[SERVICE_ID],
		serviceName: c.Labels[SERVICE_NAME],
		resourceId: c.Labels[LABEL_RESOURCE],
		cpuPercent: dSystem > 0 && dCpu >= 0 ? (dCpu / dSystem) * cpus * 100 : 0,
		memoryBytes: Math.max(0, usage - cache),
		memoryLimitBytes: s.memory_stats.limit ?? 0,
		network: { rxBytes, txBytes },
		blockIo: { readBytes, writeBytes },
	};
}

/** One-shot stats for every running container; CPU % comes from the delta against `prev`, which is updated in place. */
export async function collectContainers(
	docker: DockerClient,
	prev: Map<string, CpuPrev>,
): Promise<ContainerMetrics[]> {
	const running = await docker.containers.list();
	const results = await Promise.all(
		running.map(async (c) => {
			try {
				const s = (await docker.containers.stats(c.Id)) as Stats;
				const m = containerMetrics(c, s, prev.get(c.Id));
				prev.set(c.Id, {
					container: s.cpu_stats.cpu_usage.total_usage,
					system: s.cpu_stats.system_cpu_usage ?? 0,
				});
				return m;
			} catch {
				return undefined; // exited between list and stats
			}
		}),
	);
	const live = new Set(running.map((c) => c.Id));
	for (const id of prev.keys()) if (!live.has(id)) prev.delete(id);
	return results.filter((m) => m !== undefined);
}

const CONTAINER_ACTIONS = new Set([
	"create",
	"start",
	"die",
	"kill",
	"oom",
	"stop",
	"restart",
	"destroy",
	"health_status",
]);

/** Node and service events, plus lifecycle events of Swarm task or LogiStack-managed containers. */
export function shouldForward(e: DockerEvent): boolean {
	if (e.Type === "node" || e.Type === "service") return true;
	if (e.Type !== "container") return false;
	const action = e.Action.split(":")[0] as string;
	if (!CONTAINER_ACTIONS.has(action)) return false;
	const a = e.Actor.Attributes;
	return TASK_ID in a || a[LABEL_MANAGED] === "true";
}
