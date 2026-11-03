import { describe, expect, test } from "bun:test";
import { deriveNodeStatus } from "@logistack/contracts";
import { type MetricsEntry, toRows } from "../src/metrics-store.ts";
import {
	bootstrapScript,
	parsePreflight,
	preflightScript,
	shq,
} from "../src/node-scripts.ts";
import { sshArgv } from "../src/ssh.ts";
import { transition } from "../src/thresholds.ts";

const files = { key: "/tmp/k", knownHosts: "/tmp/kh" };

describe("sshArgv", () => {
	test("user input sits in its own argv slots and the remote command is constant", () => {
		const argv = sshArgv(
			{ host: "203.0.113.9", port: 2222, user: "deploy" },
			files,
			false,
		);
		expect(argv.slice(-4)).toEqual(["--", "203.0.113.9", "sh", "-s"]);
		expect(argv[argv.indexOf("-l") + 1]).toBe("deploy");
		expect(argv[argv.indexOf("-p") + 1]).toBe("2222");
		expect(argv).toContain("BatchMode=yes");
		expect(argv).toContain("UserKnownHostsFile=/tmp/kh");
		expect(argv).toContain("StrictHostKeyChecking=accept-new");
		expect(argv.some((a) => a.includes(" ") && !a.includes("="))).toBe(false);
	});

	test("a pinned host key is enforced", () => {
		const argv = sshArgv(
			{ host: "example.com", port: 22, user: "root" },
			files,
			true,
		);
		expect(argv).toContain("StrictHostKeyChecking=yes");
	});

	test.each([
		["-oProxyCommand=touch /tmp/pwned", "root"],
		["host; rm -rf /", "root"],
		["example.com", "-oProxyCommand=x"],
		["example.com", "root user"],
		["$(id)", "root"],
	])("rejects host %p user %p", (host, user) => {
		expect(() => sshArgv({ host, port: 22, user }, files, false)).toThrow();
	});

	test("rejects a port outside 1..65535", () => {
		expect(() =>
			sshArgv({ host: "example.com", port: 0, user: "root" }, files, false),
		).toThrow();
	});
});

describe("remote scripts", () => {
	test("shq survives single quotes", () => {
		const r = Bun.spawnSync(["sh", "-c", `printf %s ${shq("it's $(id) `x`")}`]);
		expect(r.stdout.toString()).toBe("it's $(id) `x`");
	});

	test("the join token is quoted inside the stdin script", () => {
		const s = bootstrapScript({
			token: "SWMTKN-1-abc'def",
			manager: "10.0.0.1:2377",
			role: "worker",
		});
		expect(s).toContain(`TOKEN='SWMTKN-1-abc'"'"'def'`);
		expect(s).toContain(`docker swarm join --token "$TOKEN" "$MANAGER"`);
	});

	test("scripts parse as POSIX sh", () => {
		for (const s of [
			preflightScript({ host: "10.0.0.1", port: 2377 }),
			bootstrapScript({ token: "t", manager: "m:2377", role: "manager" }),
		]) {
			const r = Bun.spawnSync(["sh", "-n"], {
				stdin: new TextEncoder().encode(s),
			});
			expect(r.exitCode).toBe(0);
		}
	});
});

describe("parsePreflight", () => {
	const ok = [
		"os=Ubuntu 24.04 LTS",
		"os_id=ubuntu",
		"arch=x86_64",
		`mem_kb=${4 * 1024 * 1024}`,
		`disk_kb=${80 * 1024 * 1024}`,
		"privileges=sudo",
		"docker=",
		"swarm=inactive",
		"port_2377=free",
		"port_7946=free",
		"manager=reachable",
	].join("\n");
	const status = (out: string) =>
		Object.fromEntries(parsePreflight(out).map((c) => [c.id, c.status]));

	test("a healthy host has no failures", () => {
		const s = status(ok);
		expect(Object.values(s)).not.toContain("fail");
		expect(s.os).toBe("ok");
		expect(s.overlay).toBe("warn");
	});

	test("blocking problems fail", () => {
		const s = status(
			ok
				.replace("privileges=sudo", "privileges=none")
				.replace("manager=reachable", "manager=unreachable")
				.replace(`mem_kb=${4 * 1024 * 1024}`, "mem_kb=400000")
				.replace(`disk_kb=${80 * 1024 * 1024}`, "disk_kb=1000000"),
		);
		expect([s.privileges, s.manager, s.memory, s.disk]).toEqual([
			"fail",
			"fail",
			"fail",
			"fail",
		]);
	});

	test("soft problems warn", () => {
		const s = status(
			ok
				.replace("os_id=ubuntu", "os_id=arch")
				.replace("swarm=inactive", "swarm=active"),
		);
		expect([s.os, s.swarm]).toEqual(["warn", "warn"]);
	});
});

describe("toRows", () => {
	const entry: MetricsEntry = {
		type: "metrics",
		at: 1_790_000_000_000,
		host: {
			cpuPercent: 12.5,
			load: [0.5, 0.4, 0.3],
			memory: { totalBytes: 1000, availableBytes: 400, usedBytes: 600 },
			swap: { totalBytes: 0, usedBytes: 0 },
			disks: [
				{
					mount: "/",
					device: "/dev/sda1",
					fsType: "ext4",
					totalBytes: 100,
					usedBytes: 40,
					availableBytes: 60,
				},
				{
					mount: "/var/lib/docker",
					device: "/dev/sda1",
					fsType: "ext4",
					totalBytes: 100,
					usedBytes: 40,
					availableBytes: 60,
				},
				{
					mount: "/data",
					device: "/dev/sdb1",
					fsType: "xfs",
					totalBytes: 50,
					usedBytes: 10,
					availableBytes: 40,
				},
			],
			network: { rxBytes: 7, txBytes: 9 },
			uptimeSec: 1,
		},
		containers: [
			{
				containerId: "c1",
				name: "ls-svc-a.1",
				resourceId: "svc_a",
				cpuPercent: 150,
				memoryBytes: 5,
				memoryLimitBytes: 10,
				network: { rxBytes: 1, txBytes: 2 },
				blockIo: { readBytes: 3, writeBytes: 4 },
			},
		],
	};

	test("disks count once per device", () => {
		const { host } = toRows("n1", entry);
		expect(host).toMatchObject({
			disk_used: 50,
			disk_total: 150,
			cpu: 12.5,
			load1: 0.5,
			mem_used: 600,
		});
		expect(host?.ts.getTime()).toBe(entry.at);
	});

	test("containers keep the LogiStack service id", () => {
		expect(toRows("n1", entry).containers[0]).toMatchObject({
			service_id: "svc_a",
			cpu: 150,
			blk_write: 4,
		});
		expect(toRows("n1", { ...entry, host: null }).host).toBeUndefined();
	});
});

test("threshold transitions emit once per crossing", () => {
	expect(transition(undefined, 10, 80)).toEqual({
		firing: false,
		emit: undefined,
	});
	expect(transition(undefined, 90, 80)).toEqual({
		firing: true,
		emit: "firing",
	});
	expect(transition(true, 95, 80)).toEqual({ firing: true, emit: undefined });
	expect(transition(true, 80, 80)).toEqual({ firing: false, emit: "resolved" });
	expect(transition(false, 79, 80)).toEqual({ firing: false, emit: undefined });
});

test("node status", () => {
	const base = {
		swarmState: "ready",
		availability: "active",
		agentPresent: true,
		agentEverSeen: true,
	} as const;
	expect(deriveNodeStatus(base)).toBe("ready");
	expect(deriveNodeStatus({ ...base, availability: "drain" })).toBe("draining");
	expect(deriveNodeStatus({ ...base, swarmState: "down" })).toBe("down");
	expect(deriveNodeStatus({ ...base, agentPresent: false })).toBe("down");
	expect(
		deriveNodeStatus({ ...base, agentPresent: false, agentEverSeen: false }),
	).toBe("pending");
});
