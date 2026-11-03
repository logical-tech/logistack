import { describe, expect, test } from "bun:test";
import {
	AgentMessage,
	MAX_CHUNK_BYTES,
	MAX_FRAME_BYTES,
	parseFrame,
	ServerMessage,
} from "../src/index.ts";

const host = {
	cpuPercent: 12.5,
	load: [0.1, 0.2, 0.3],
	memory: { totalBytes: 8e9, availableBytes: 6e9, usedBytes: 2e9 },
	swap: { totalBytes: 0, usedBytes: 0 },
	disks: [
		{
			mount: "/",
			device: "/dev/vda1",
			fsType: "ext4",
			totalBytes: 1e11,
			usedBytes: 4e10,
			availableBytes: 6e10,
		},
	],
	network: { rxBytes: 1, txBytes: 2 },
	uptimeSec: 100,
};

const agentMessages: unknown[] = [
	{
		type: "hello",
		protocol: 1,
		nodeId: "n1",
		hostname: "h",
		version: "0.1.0",
		capabilities: ["exec", "logs", "jobs", "metrics", "events"],
	},
	{ type: "heartbeat", at: 1 },
	{
		type: "metrics",
		at: 1,
		host,
		containers: [
			{
				containerId: "c",
				name: "ls-svc-a.1.x",
				taskId: "t",
				serviceId: "s",
				cpuPercent: 150,
				memoryBytes: 1,
				memoryLimitBytes: 2,
				network: { rxBytes: 0, txBytes: 0 },
				blockIo: { readBytes: 0, writeBytes: 0 },
			},
		],
	},
	{ type: "metrics", at: 1, host: null, containers: [] },
	{
		type: "docker_event",
		event: {
			Type: "container",
			Action: "die",
			Actor: { ID: "c", Attributes: { exitCode: "1" } },
			scope: "local",
			time: 1,
			timeNano: 1e9,
		},
	},
	{ type: "exec.output", id: "r", stream: "stdout", data: "aGk=" },
	{ type: "exec.exit", id: "r", code: 0 },
	{ type: "exec.exit", id: "r", code: null },
	{ type: "logs.line", id: "r", stream: "stderr", line: "x" },
	{ type: "logs.end", id: "r" },
	{ type: "job.output", id: "r", stream: "stdout", data: "" },
	{
		type: "job.result",
		id: "r",
		exitCode: 7,
		bytes: 10,
		truncated: false,
		durationMs: 5,
	},
	{ type: "rpc.error", id: "r", code: "not_found", message: "no task" },
];

const serverMessages: unknown[] = [
	{ type: "heartbeat", at: 1 },
	{
		type: "exec.start",
		id: "r",
		target: { kind: "task", taskId: "t" },
		cmd: ["sh"],
		tty: true,
		size: { rows: 24, cols: 80 },
	},
	{ type: "exec.stdin", id: "r", data: "aGk=", eof: true },
	{ type: "exec.resize", id: "r", rows: 1, cols: 1 },
	{ type: "exec.close", id: "r" },
	{
		type: "logs.follow",
		id: "r",
		target: { kind: "service", serviceId: "s" },
	},
	{ type: "logs.stop", id: "r" },
	{
		type: "run.job",
		id: "r",
		job: {
			kind: "exec",
			target: { kind: "task", taskId: "t" },
			cmd: ["pg_dump", "-Fc"],
			timeoutSec: 60,
		},
	},
	{
		type: "run.job",
		id: "r",
		job: {
			kind: "container",
			image: "busybox:1.37",
			containerName: "ls-job-abc",
			script: "echo hi",
			mounts: [{ type: "volume", source: "v", target: "/data" }],
			timeoutSec: 60,
		},
	},
	{ type: "job.cancel", id: "r" },
];

describe("agent protocol", () => {
	test("every agent message survives serialize and parse", () => {
		for (const m of agentMessages) {
			const parsed = AgentMessage.parse(m);
			expect(parseFrame(AgentMessage, JSON.stringify(parsed))).toEqual(parsed);
		}
	});

	test("every server message survives serialize and parse", () => {
		for (const m of serverMessages) {
			const parsed = ServerMessage.parse(m);
			expect(parseFrame(ServerMessage, JSON.stringify(parsed))).toEqual(parsed);
		}
	});

	test("defaults fill in on parse", () => {
		expect(ServerMessage.parse(serverMessages[1])).toMatchObject({
			stdin: true,
			env: [],
		});
		const msg = ServerMessage.parse(serverMessages[8]);
		if (msg.type !== "run.job" || msg.job.kind !== "container")
			throw new Error("wrong variant");
		expect(msg.job.cmd).toEqual(["sh"]);
		expect(msg.job.outputLimitBytes).toBe(1024 * 1024);
		expect(msg.job.mounts[0]?.readOnly).toBe(false);
	});

	test("rejects malformed frames", () => {
		expect(() => AgentMessage.parse({ type: "hello", protocol: 2 })).toThrow();
		expect(() =>
			AgentMessage.parse({
				type: "exec.output",
				id: "",
				stream: "stdout",
				data: "",
			}),
		).toThrow();
		expect(() =>
			AgentMessage.parse({
				type: "exec.output",
				id: "r",
				stream: "stdout",
				data: "A".repeat(Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4),
			}),
		).toThrow();
		expect(() =>
			ServerMessage.parse({
				type: "run.job",
				id: "r",
				job: {
					kind: "container",
					image: "x",
					containerName: "Evil Name",
					timeoutSec: 1,
				},
			}),
		).toThrow();
		expect(() =>
			parseFrame(AgentMessage, " ".repeat(MAX_FRAME_BYTES + 1)),
		).toThrow(/exceeds/);
	});

	test("a full output chunk fits in one frame", () => {
		const data = Buffer.alloc(MAX_CHUNK_BYTES, 255).toString("base64");
		const frame = JSON.stringify(
			AgentMessage.parse({
				type: "exec.output",
				id: "x".repeat(64),
				stream: "stdout",
				data,
			}),
		);
		expect(frame.length).toBeLessThan(MAX_FRAME_BYTES);
	});
});
