import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostMetrics, MAX_LINE_BYTES } from "@logistack/contracts";
import type { DockerEvent } from "@logistack/docker";
import { containerMetrics, shouldForward } from "../src/docker.ts";
import { cpuPercent, parseCpu, parseMounts, readHost } from "../src/host.ts";
import { backoffMs, failureLogger } from "../src/index.ts";
import { renderPrometheus } from "../src/prometheus.ts";
import { lineSplitter } from "../src/sessions.ts";

describe("host parsers", () => {
	test("cpu percent from two /proc/stat samples", () => {
		const a = parseCpu("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3");
		const b = parseCpu("cpu  150 0 150 750 150 0 0 0 0 0\n");
		expect(a).toEqual({ total: 1000, idle: 800, iowait: 100, steal: 0 });
		// 200 jiffies passed, 100 of them idle or iowait
		expect(cpuPercent(a, b)).toBe(50);
		expect(cpuPercent(b, b)).toBe(0);
	});

	test("mounts keep block devices once, decoding escapes", () => {
		const mounts = parseMounts(
			[
				"/dev/vda1 / ext4 rw 0 0",
				"/dev/vda1 /var/lib/docker ext4 rw 0 0",
				"/dev/vdb /mnt/my\\040data xfs rw 0 0",
				"overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0",
				"tmpfs /run tmpfs rw 0 0",
				"/dev/loop0 /snap/core squashfs ro 0 0",
				"proc /proc proc rw 0 0",
			].join("\n"),
		);
		expect(mounts).toEqual([
			{ device: "/dev/vda1", mount: "/", fsType: "ext4" },
			{ device: "/dev/vdb", mount: "/mnt/my data", fsType: "xfs" },
		]);
	});

	test("readHost over a fake /proc and /sys", () => {
		const root = mkdtempSync(join(tmpdir(), "ls-agent-host-"));
		const proc = join(root, "proc");
		const sys = join(root, "sys");
		mkdirSync(join(proc, "1"), { recursive: true });
		writeFileSync(join(proc, "stat"), "cpu  10 0 10 80 0 0 0 0\n");
		writeFileSync(
			join(proc, "meminfo"),
			"MemTotal:  1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n",
		);
		writeFileSync(join(proc, "loadavg"), "0.50 0.25 0.10 1/100 42\n");
		writeFileSync(join(proc, "uptime"), "1234.56 999.00\n");
		writeFileSync(join(proc, "1/mounts"), "/dev/sda1 / ext4 rw 0 0\n");
		for (const [iface, rx, tx] of [
			["eth0", 100, 200],
			["ens5", 1, 2],
			["lo", 5000, 5000],
			["veth1", 7000, 7000],
			["docker_gwbridge", 7000, 7000],
			["br-0123", 7000, 7000],
		] as const) {
			const dir = join(sys, "class/net", iface);
			mkdirSync(join(dir, "statistics"), { recursive: true });
			writeFileSync(join(dir, "statistics/rx_bytes"), `${rx}\n`);
			writeFileSync(join(dir, "statistics/tx_bytes"), `${tx}\n`);
		}
		const paths = { proc, sys, root: "/" };
		const first = readHost(paths, undefined);
		writeFileSync(join(proc, "stat"), "cpu  20 0 20 90 0 0 0 0\n");
		const second = readHost(paths, first?.cpu);
		const host = HostMetrics.parse(second?.host);
		expect(host.cpuPercent).toBeCloseTo(66.67, 1);
		expect(host.load).toEqual([0.5, 0.25, 0.1]);
		expect(host.memory).toEqual({
			totalBytes: 1024000,
			availableBytes: 614400,
			usedBytes: 409600,
		});
		expect(host.swap).toEqual({ totalBytes: 204800, usedBytes: 153600 });
		expect(host.network).toEqual({ rxBytes: 101, txBytes: 202 });
		expect(host.uptimeSec).toBe(1234.56);
		expect(host.disks).toHaveLength(1);
		expect(host.disks[0]?.totalBytes).toBeGreaterThan(0);
		expect(
			readHost({ ...paths, proc: join(root, "missing") }, undefined),
		).toBeNull();
	});
});

describe("container metrics", () => {
	const c = {
		Id: "abc",
		Names: ["/ls-svc-x.1.t1"],
		Labels: {
			"com.docker.swarm.task.id": "t1",
			"com.docker.swarm.service.id": "s1",
			"logistack.resource": "svc_1",
		},
	};
	const stats = (cpu: number, system: number) =>
		({
			read: "",
			id: "abc",
			name: "/x",
			cpu_stats: {
				cpu_usage: { total_usage: cpu },
				system_cpu_usage: system,
				online_cpus: 4,
			},
			precpu_stats: { cpu_usage: { total_usage: 0 } },
			memory_stats: {
				usage: 1000,
				limit: 5000,
				stats: { inactive_file: 300 },
			},
			networks: {
				eth0: { rx_bytes: 1, tx_bytes: 2 },
				eth1: { rx_bytes: 10, tx_bytes: 20 },
			},
			blkio_stats: {
				io_service_bytes_recursive: [
					{ op: "read", value: 7 },
					{ op: "write", value: 9 },
					{ op: "Read", value: 1 },
				],
			},
		}) as never;

	test("computes deltas and docker-style memory", () => {
		const m = containerMetrics(c, stats(300, 2000), {
			container: 100,
			system: 1000,
		});
		// 200 of 1000 system ticks across 4 cpus
		expect(m.cpuPercent).toBe(80);
		expect(m.memoryBytes).toBe(700);
		expect(m.memoryLimitBytes).toBe(5000);
		expect(m.network).toEqual({ rxBytes: 11, txBytes: 22 });
		expect(m.blockIo).toEqual({ readBytes: 8, writeBytes: 9 });
		expect(m).toMatchObject({
			name: "ls-svc-x.1.t1",
			taskId: "t1",
			serviceId: "s1",
			resourceId: "svc_1",
		});
		expect(containerMetrics(c, stats(300, 2000), undefined).cpuPercent).toBe(0);
	});
});

describe("event filter", () => {
	const ev = (
		Type: string,
		Action: string,
		Attributes: Record<string, string> = {},
	) =>
		({
			Type,
			Action,
			Actor: { ID: "x", Attributes },
			scope: "local",
			time: 0,
			timeNano: 0,
		}) as DockerEvent;

	test("forwards swarm and managed lifecycle events only", () => {
		expect(shouldForward(ev("node", "update"))).toBe(true);
		expect(shouldForward(ev("service", "update"))).toBe(true);
		expect(
			shouldForward(
				ev("container", "die", { "com.docker.swarm.task.id": "t" }),
			),
		).toBe(true);
		expect(
			shouldForward(
				ev("container", "health_status: unhealthy", {
					"logistack.managed": "true",
				}),
			),
		).toBe(true);
		expect(
			shouldForward(
				ev("container", "exec_start: sh", { "logistack.managed": "true" }),
			),
		).toBe(false);
		expect(
			shouldForward(ev("container", "die", { name: "someone-elses" })),
		).toBe(false);
		expect(shouldForward(ev("image", "pull"))).toBe(false);
	});
});

describe("line splitter", () => {
	test("joins partial frames and cuts long lines", () => {
		const s = lineSplitter();
		const enc = (t: string) => new TextEncoder().encode(t);
		expect(s.push("stdout", enc("a\nb"))).toEqual(["a"]);
		expect(s.push("stderr", enc("x"))).toEqual([]);
		expect(s.push("stdout", enc("c\n"))).toEqual(["bc"]);
		const long = s.push("stdout", enc("z".repeat(MAX_LINE_BYTES + 5)));
		expect(long).toEqual(["z".repeat(MAX_LINE_BYTES)]);
		expect(s.flush()).toEqual([
			["stdout", "zzzzz"],
			["stderr", "x"],
		]);
	});

	test("utf-8 split across frames survives", () => {
		const s = lineSplitter();
		const bytes = new TextEncoder().encode("è\n");
		expect(s.push("stdout", bytes.subarray(0, 1))).toEqual([]);
		expect(s.push("stdout", bytes.subarray(1))).toEqual(["è"]);
	});
});

test("backoff is jittered and capped", () => {
	expect(backoffMs(0, () => 0.999)).toBeLessThan(500);
	expect(backoffMs(3, () => 0.5)).toBe(2000);
	expect(backoffMs(20, () => 0.999)).toBeLessThan(30_000);
	expect(backoffMs(5, () => 0)).toBe(0);
});

test("connection failures: each distinct one logged, repeats folded per window", () => {
	const lines: Record<string, unknown>[] = [];
	let t = 0;
	const report = failureLogger(
		(f) => lines.push(f),
		30_000,
		() => t,
	);
	const refused = { status: 503, code: "setup_required" };
	report(refused, 1, 400);
	t = 1_000;
	report(refused, 2, 900);
	report(refused, 3, 1_500);
	report({ error: "Failed to connect" }, 4, 3_000);
	t = 20_000;
	report({ error: "Failed to connect" }, 5, 9_000);
	t = 40_000;
	report({ error: "Failed to connect" }, 6, 20_000);
	expect(lines).toEqual([
		{ ...refused, attempt: 1, backoffMs: 400, suppressed: 0 },
		{ error: "Failed to connect", attempt: 4, backoffMs: 3_000, suppressed: 2 },
		{
			error: "Failed to connect",
			attempt: 6,
			backoffMs: 20_000,
			suppressed: 1,
		},
	]);
});

test("prometheus text escapes labels and skips empty families", () => {
	const text = renderPrometheus({
		host: null,
		containers: [
			{
				containerId: "c",
				name: 'we"ird',
				cpuPercent: 1.5,
				memoryBytes: 10,
				memoryLimitBytes: 0,
				network: { rxBytes: 1, txBytes: 2 },
				blockIo: { readBytes: 3, writeBytes: 4 },
			},
		],
		connected: true,
		droppedMessages: 2,
		sessions: 0,
	});
	expect(text).toContain("logistack_agent_connected 1\n");
	expect(text).toContain("logistack_agent_dropped_messages_total 2\n");
	expect(text).toContain(
		'logistack_container_cpu_percent{container="we\\"ird"} 1.5',
	);
	expect(text).toContain(
		'logistack_container_network_bytes_total{container="we\\"ird",direction="tx"} 2',
	);
	expect(text).not.toContain("logistack_host_");
});

describe("host gaps", () => {
	test("diskstats sums whole disks only, in bytes", async () => {
		const { parseDiskstats } = await import("../src/host.ts");
		const text = [
			"   8       0 sda 100 0 2000 50 300 0 4000 80 0 0 0",
			"   8       1 sda1 90 0 1800 40 290 0 3900 70 0 0 0",
			" 259       0 nvme0n1 10 0 20 1 30 0 40 2 0 0 0",
			"   7       0 loop0 5 0 999 1 0 0 0 0 0 0 0",
			" 253       0 dm-0 5 0 999 1 0 0 999 0 0 0 0",
		].join("\n");
		expect(parseDiskstats(text)).toEqual({
			readBytes: (2000 + 20) * 512,
			writeBytes: (4000 + 40) * 512,
		});
	});

	test("iowait and steal shares come from deltas", async () => {
		const { cpuShare, parseCpu } = await import("../src/host.ts");
		const a = parseCpu("cpu 100 0 100 700 50 0 0 50 0 0\n");
		const b = parseCpu("cpu 200 0 200 1300 150 0 0 150 0 0\n");
		expect(cpuShare(a, b, "iowait")).toBeCloseTo(10, 5);
		expect(cpuShare(a, b, "steal")).toBeCloseTo(10, 5);
	});

	test("temperatures read hwmon inputs with labels", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { temperatures } = await import("../src/host.ts");
		const sys = mkdtempSync(join(tmpdir(), "ls-hwmon-"));
		const chip = join(sys, "class/hwmon/hwmon0");
		mkdirSync(chip, { recursive: true });
		writeFileSync(join(chip, "name"), "coretemp\n");
		writeFileSync(join(chip, "temp1_input"), "54000\n");
		writeFileSync(join(chip, "temp1_label"), "Package id 0\n");
		writeFileSync(join(chip, "temp2_input"), "-273000\n");
		expect(temperatures(sys)).toEqual([
			{ sensor: "coretemp/Package id 0", celsius: 54 },
		]);
		expect(temperatures(join(sys, "missing"))).toEqual([]);
	});
});
