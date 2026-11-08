import type { ContainerMetrics, HostMetrics } from "@logistack/contracts";

export interface Snapshot {
	host: HostMetrics | null;
	containers: ContainerMetrics[];
	connected: boolean;
	droppedMessages: number;
	sessions: number;
}

const esc = (v: string) =>
	v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (l: Record<string, string | undefined>) => {
	const parts = Object.entries(l)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}="${esc(v as string)}"`);
	return parts.length ? `{${parts.join(",")}}` : "";
};

/** Prometheus text exposition format 0.0.4. */
export function renderPrometheus(s: Snapshot): string {
	const out: string[] = [];
	const metric = (
		name: string,
		type: "gauge" | "counter",
		help: string,
		samples: [Record<string, string | undefined>, number][],
	) => {
		if (!samples.length) return;
		out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
		for (const [l, v] of samples) out.push(`${name}${labels(l)} ${v}`);
	};

	metric(
		"logistack_agent_connected",
		"gauge",
		"1 while connected to the server.",
		[[{}, s.connected ? 1 : 0]],
	);
	metric(
		"logistack_agent_dropped_messages_total",
		"counter",
		"Telemetry messages dropped by backpressure or disconnect.",
		[[{}, s.droppedMessages]],
	);
	metric(
		"logistack_agent_sessions",
		"gauge",
		"Open exec, log and job sessions.",
		[[{}, s.sessions]],
	);

	const h = s.host;
	if (h) {
		metric("logistack_host_cpu_percent", "gauge", "Host CPU use, 0-100.", [
			[{}, h.cpuPercent],
		]);
		metric("logistack_host_load", "gauge", "Load average.", [
			[{ window: "1m" }, h.load[0]],
			[{ window: "5m" }, h.load[1]],
			[{ window: "15m" }, h.load[2]],
		]);
		metric("logistack_host_memory_bytes", "gauge", "Host memory.", [
			[{ kind: "total" }, h.memory.totalBytes],
			[{ kind: "available" }, h.memory.availableBytes],
			[{ kind: "used" }, h.memory.usedBytes],
		]);
		metric("logistack_host_swap_bytes", "gauge", "Host swap.", [
			[{ kind: "total" }, h.swap.totalBytes],
			[{ kind: "used" }, h.swap.usedBytes],
		]);
		metric(
			"logistack_host_disk_bytes",
			"gauge",
			"Filesystem size per mount.",
			h.disks.flatMap((d) => [
				[{ mount: d.mount, device: d.device, kind: "total" }, d.totalBytes],
				[{ mount: d.mount, device: d.device, kind: "used" }, d.usedBytes],
				[
					{ mount: d.mount, device: d.device, kind: "available" },
					d.availableBytes,
				],
			]) as [Record<string, string>, number][],
		);
		metric(
			"logistack_host_network_bytes_total",
			"counter",
			"Physical NIC traffic.",
			[
				[{ direction: "rx" }, h.network.rxBytes],
				[{ direction: "tx" }, h.network.txBytes],
			],
		);
		metric("logistack_host_uptime_seconds", "gauge", "Host uptime.", [
			[{}, h.uptimeSec],
		]);
		if (h.diskIo)
			metric(
				"logistack_host_disk_io_bytes_total",
				"counter",
				"Bytes read and written on whole physical disks.",
				[
					[{ op: "read" }, h.diskIo.readBytes],
					[{ op: "write" }, h.diskIo.writeBytes],
				],
			);
		if (h.temperatures?.length)
			metric(
				"logistack_host_temperature_celsius",
				"gauge",
				"hwmon sensor temperature.",
				h.temperatures.map((t) => [{ sensor: t.sensor }, t.celsius]),
			);
	}

	const c = (m: ContainerMetrics, extra: Record<string, string> = {}) => ({
		container: m.name,
		service: m.serviceName,
		task: m.taskId,
		...extra,
	});
	metric(
		"logistack_container_cpu_percent",
		"gauge",
		"Container CPU, 100 per core.",
		s.containers.map((m) => [c(m), m.cpuPercent]),
	);
	metric(
		"logistack_container_memory_bytes",
		"gauge",
		"Container memory without reclaimable cache.",
		s.containers.map((m) => [c(m), m.memoryBytes]),
	);
	metric(
		"logistack_container_network_bytes_total",
		"counter",
		"Container network traffic.",
		s.containers.flatMap((m) => [
			[c(m, { direction: "rx" }), m.network.rxBytes],
			[c(m, { direction: "tx" }), m.network.txBytes],
		]) as [Record<string, string>, number][],
	);
	metric(
		"logistack_container_block_io_bytes_total",
		"counter",
		"Container block IO.",
		s.containers.flatMap((m) => [
			[c(m, { op: "read" }), m.blockIo.readBytes],
			[c(m, { op: "write" }), m.blockIo.writeBytes],
		]) as [Record<string, string>, number][],
	);
	return `${out.join("\n")}\n`;
}
