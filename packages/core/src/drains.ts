import type { LogDrainConfig, LogRecord } from "@logistack/contracts";

/** What one batch becomes on the wire: an HTTP POST, or syslog messages for one connection. */
export type EncodedBatch =
	| { kind: "http"; url: string; headers: Record<string, string>; body: string }
	| {
			kind: "syslog";
			host: string;
			port: number;
			protocol: "tcp" | "tls" | "udp";
			/** Already framed for TCP/TLS; one datagram each for UDP. */
			messages: string[];
	  };

function withPath(base: string, suffix: string): string {
	const u = new URL(base);
	if (u.pathname === "/" || u.pathname === "") u.pathname = suffix;
	return u.href;
}

export const lokiPushUrl = (url: string) => withPath(url, "/loki/api/v1/push");
export const otlpLogsUrl = (url: string) => withPath(url, "/v1/logs");
export const datadogIntakeUrl = (site: string) =>
	`https://http-intake.logs.${site}/api/v2/logs`;

/** The destination as shown in lists: no credentials, no query string. */
export function drainTarget(c: LogDrainConfig): string {
	switch (c.kind) {
		case "loki":
		case "otlp":
		case "http": {
			const u = new URL(
				c.kind === "loki"
					? lokiPushUrl(c.url)
					: c.kind === "otlp"
						? otlpLogsUrl(c.url)
						: c.url,
			);
			return `${u.origin}${u.pathname}`;
		}
		case "datadog":
			return `http-intake.logs.${c.site}`;
		case "syslog":
			return `${c.protocol}://${c.host}:${c.port}`;
	}
}

const nanoTime = (r: LogRecord) =>
	(BigInt(r.at) * 1_000_000n + BigInt(r.nanos ?? 0)).toString();

/** Loki stream labels: low cardinality, names for people, ids for joins. */
export function lokiLabels(r: LogRecord): Record<string, string> {
	return {
		source: "logistack",
		organization: r.meta.organization,
		project: r.meta.project,
		environment: r.meta.environment,
		service: r.meta.service,
		service_id: r.meta.serviceId,
		deployment_id: r.deploymentId,
		node: r.node,
		stream: r.stream,
	};
}

function groupBy<K>(records: LogRecord[], key: (r: LogRecord) => K) {
	const groups = new Map<string, { key: K; records: LogRecord[] }>();
	for (const r of records) {
		const k = key(r);
		const id = JSON.stringify(k);
		const g = groups.get(id);
		if (g) g.records.push(r);
		else groups.set(id, { key: k, records: [r] });
	}
	return [...groups.values()];
}

const attr = (key: string, value: string) => ({
	key,
	value: { stringValue: value },
});

function otlpBody(records: LogRecord[]) {
	return {
		resourceLogs: groupBy(records, (r) => [
			r.meta.serviceId,
			r.deploymentId,
			r.node,
		]).map(({ records: rs }) => {
			const r = rs[0] as LogRecord;
			return {
				resource: {
					attributes: [
						attr("service.name", r.meta.service),
						attr("service.namespace", r.meta.project),
						attr("deployment.environment.name", r.meta.environment),
						attr("host.name", r.node),
						attr("logistack.organization", r.meta.organization),
						attr("logistack.organization_id", r.meta.organizationId),
						attr("logistack.project_id", r.meta.projectId),
						attr("logistack.environment_id", r.meta.environmentId),
						attr("logistack.service_id", r.meta.serviceId),
						attr("logistack.deployment_id", r.deploymentId),
					],
				},
				scopeLogs: [
					{
						scope: { name: "logistack" },
						logRecords: rs.map((x) => ({
							timeUnixNano: nanoTime(x),
							body: { stringValue: x.line },
							attributes: [attr("log.iostream", x.stream)],
						})),
					},
				],
			};
		}),
	};
}

/** The generic HTTP JSON record; documented on the docs site. */
export const httpRecord = (r: LogRecord) => ({
	timestamp: new Date(r.at).toISOString(),
	message: r.line,
	stream: r.stream,
	organization: r.meta.organization,
	organizationId: r.meta.organizationId,
	project: r.meta.project,
	projectId: r.meta.projectId,
	environment: r.meta.environment,
	environmentId: r.meta.environmentId,
	service: r.meta.service,
	serviceId: r.meta.serviceId,
	deploymentId: r.deploymentId,
	node: r.node,
});

const ddTag = (k: string, v: string) =>
	`${k}:${v.toLowerCase().replace(/[^a-z0-9_.:/-]/g, "_")}`;

// RFC 5424: PRINTUSASCII without spaces, bounded per field.
const sysField = (v: string, max: number) =>
	v.replace(/[^\x21-\x7e]/g, "_").slice(0, max) || "-";
const sdValue = (v: string) => v.replace(/[\\"\]]/g, (c) => `\\${c}`);
/** 32473 is the private enterprise number RFC 5612 reserves for documentation and examples. */
const SD_ID = "logistack@32473";

export function syslogMessage(r: LogRecord): string {
	const pri = 8 + (r.stream === "stderr" ? 3 : 6); // facility user, severity err / info
	const sd = [
		["org", r.meta.organization],
		["project", r.meta.project],
		["environment", r.meta.environment],
		["service_id", r.meta.serviceId],
		["deployment_id", r.deploymentId],
	]
		.map(([k, v]) => `${k}="${sdValue(v as string)}"`)
		.join(" ");
	return `<${pri}>1 ${new Date(r.at).toISOString()} ${sysField(r.node, 255)} ${sysField(r.meta.service, 48)} - ${r.stream} [${SD_ID} ${sd}] ${r.line}`;
}

/** Pure: config plus records in, request description out. */
export function encodeDrainBatch(
	c: LogDrainConfig,
	records: LogRecord[],
): EncodedBatch {
	const jsonHeaders = { "content-type": "application/json" };
	switch (c.kind) {
		case "loki": {
			const headers: Record<string, string> = { ...jsonHeaders };
			if (c.tenantId) headers["x-scope-orgid"] = c.tenantId;
			if (c.bearerToken) headers.authorization = `Bearer ${c.bearerToken}`;
			else if (c.username)
				headers.authorization = `Basic ${Buffer.from(`${c.username}:${c.password ?? ""}`).toString("base64")}`;
			const streams = groupBy(records, lokiLabels).map((g) => ({
				stream: g.key,
				values: g.records.map((r) => [nanoTime(r), r.line]),
			}));
			return {
				kind: "http",
				url: lokiPushUrl(c.url),
				headers,
				body: JSON.stringify({ streams }),
			};
		}
		case "otlp":
			return {
				kind: "http",
				url: otlpLogsUrl(c.url),
				headers: { ...c.headers, ...jsonHeaders },
				body: JSON.stringify(otlpBody(records)),
			};
		case "http":
			return {
				kind: "http",
				url: c.url,
				headers: { ...c.headers, ...jsonHeaders },
				body: JSON.stringify(records.map(httpRecord)),
			};
		case "datadog":
			return {
				kind: "http",
				url: datadogIntakeUrl(c.site),
				headers: { ...jsonHeaders, "dd-api-key": c.apiKey },
				body: JSON.stringify(
					records.map((r) => ({
						message: r.line,
						ddsource: "logistack",
						service: r.meta.service,
						hostname: r.node,
						timestamp: r.at,
						ddtags: [
							ddTag("env", r.meta.environment),
							ddTag("project", r.meta.project),
							ddTag("organization", r.meta.organization),
							ddTag("service_id", r.meta.serviceId),
							ddTag("deployment_id", r.deploymentId),
							ddTag("stream", r.stream),
						].join(","),
					})),
				),
			};
		case "syslog": {
			const messages = records.map(syslogMessage);
			return {
				kind: "syslog",
				host: c.host,
				port: c.port,
				protocol: c.protocol,
				messages:
					c.protocol === "udp"
						? messages
						: messages.map((m) => `${Buffer.byteLength(m)} ${m}`),
			};
		}
	}
}
