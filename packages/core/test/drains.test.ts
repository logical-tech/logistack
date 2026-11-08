import { describe, expect, test } from "bun:test";
import { LogDrainConfig, type LogRecord } from "@logistack/contracts";
import { drainTarget, encodeDrainBatch } from "../src/drains.ts";

const meta = {
	organizationId: "org_1",
	organization: "Acme",
	projectId: "prj_1",
	project: "shop",
	environmentId: "env_1",
	environment: "production",
	serviceId: "svc_1",
	service: "web api",
};
const records: LogRecord[] = [
	{
		at: Date.UTC(2026, 10, 7, 10, 0, 0, 123),
		nanos: 456789,
		stream: "stdout",
		line: "hello",
		meta,
		deploymentId: "dep_1",
		node: "node-a",
	},
	{
		at: Date.UTC(2026, 10, 7, 10, 0, 1),
		stream: "stderr",
		line: 'boom "quoted" ]',
		meta,
		deploymentId: "dep_1",
		node: "node-a",
	},
];

const cfg = (raw: unknown) => LogDrainConfig.parse(raw);

describe("encodeDrainBatch", () => {
	test.each([
		[
			{
				kind: "loki",
				url: "https://loki.example.com",
				username: "u",
				password: "p",
				tenantId: "t",
			},
		],
		[
			{
				kind: "otlp",
				url: "https://otel.example.com:4318",
				headers: { "x-api-key": "k" },
			},
		],
		[{ kind: "http", url: "https://logs.example.com/ingest?token=abc" }],
		[{ kind: "datadog", site: "datadoghq.eu", apiKey: "dd" }],
		[
			{
				kind: "syslog",
				host: "syslog.example.com",
				port: 6514,
				protocol: "tls",
			},
		],
		[{ kind: "syslog", host: "10.0.0.1", protocol: "udp" }],
	])("%o", (raw) => {
		expect(encodeDrainBatch(cfg(raw), records)).toMatchSnapshot();
	});

	test("loki groups lines by label set with nanosecond timestamps", () => {
		const b = encodeDrainBatch(
			cfg({ kind: "loki", url: "http://loki:3100/" }),
			records,
		);
		if (b.kind !== "http") throw new Error("expected http");
		expect(b.url).toBe("http://loki:3100/loki/api/v1/push");
		const { streams } = JSON.parse(b.body);
		expect(streams).toHaveLength(2);
		expect(streams[0].stream).toMatchObject({
			organization: "Acme",
			project: "shop",
			environment: "production",
			service: "web api",
			deployment_id: "dep_1",
			node: "node-a",
			stream: "stdout",
		});
		expect(streams[0].values[0][0]).toBe("1794045600123456789");
	});

	test("syslog over TCP uses octet counting", () => {
		const b = encodeDrainBatch(cfg({ kind: "syslog", host: "h" }), records);
		if (b.kind !== "syslog") throw new Error("expected syslog");
		const m = b.messages[0] as string;
		const [len, ...rest] = m.split(" ");
		expect(Number(len)).toBe(Buffer.byteLength(rest.join(" ")));
		expect(b.messages[1]).toContain('[logistack@32473 org="Acme"');
		expect(b.messages[1]).toContain("<11>1 ");
	});
});

test("drainTarget never shows credentials or query strings", () => {
	expect(
		drainTarget(
			cfg({
				kind: "http",
				url: "https://user:pw@logs.example.com/in?token=abc",
			}),
		),
	).toBe("https://logs.example.com/in");
	expect(drainTarget(cfg({ kind: "loki", url: "http://loki:3100" }))).toBe(
		"http://loki:3100/loki/api/v1/push",
	);
});
