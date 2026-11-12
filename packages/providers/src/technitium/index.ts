import {
	type HomeDnsLogPage,
	type HomeDnsLogQuery,
	type HomeDnsRecord,
	type HomeDnsRecordInput,
	HomeDnsRecordType,
	type HomeDnsSettings,
	type HomeDnsStats,
	type HomeDnsStatsRange,
	type HomeDnsTestResult,
	type HomeDnsZone,
	homeDnsRecordId,
	parseDnsValue,
} from "@logistack/contracts";
import { z } from "zod";
import { type Deps, Http, ProviderError } from "../http.ts";

/** Technitium answered with `status: error` or `invalid-token`. */
export class TechnitiumError extends ProviderError {
	constructor(
		op: string,
		message: string,
		readonly invalidToken: boolean,
	) {
		super("technitium", op, message);
		this.name = "TechnitiumError";
	}
}

export const QUERY_LOG_APP = {
	name: "Query Logs (Sqlite)",
	classPath: "QueryLogsSqlite.App",
} as const;

const Envelope = z.object({
	status: z.string(),
	errorMessage: z.string().optional(),
	response: z.unknown().optional(),
});

const ranges: Record<HomeDnsStatsRange, string> = {
	hour: "LastHour",
	day: "LastDay",
	week: "LastWeek",
	month: "LastMonth",
	year: "LastYear",
};

const Top = z.object({
	name: z.string(),
	domain: z.string().optional(),
	hits: z.number(),
});
const Chart = z.object({
	labels: z.array(z.string()),
	datasets: z.array(z.object({ label: z.string(), data: z.array(z.number()) })),
});
const Stats = z.object({
	stats: z.object({
		totalQueries: z.number(),
		totalNoError: z.number(),
		totalServerFailure: z.number(),
		totalNxDomain: z.number(),
		totalRefused: z.number(),
		totalAuthoritative: z.number(),
		totalRecursive: z.number(),
		totalCached: z.number(),
		totalBlocked: z.number(),
		totalDropped: z.number(),
		totalClients: z.number(),
	}),
	mainChartData: Chart,
	topClients: z.array(Top),
	topDomains: z.array(Top),
	topBlockedDomains: z.array(Top),
});

const LogPage = z.object({
	pageNumber: z.number(),
	totalPages: z.number(),
	totalEntries: z.number(),
	entries: z.array(
		z.object({
			timestamp: z.string(),
			clientIpAddress: z.string(),
			protocol: z.string(),
			responseType: z.string(),
			responseRtt: z.number().optional(),
			rcode: z.string(),
			qname: z.string().nullish(),
			qtype: z.string().nullish(),
			answer: z.string().nullish(),
		}),
	),
});

const RecordRow = z.object({
	name: z.string(),
	type: z.string(),
	ttl: z.number(),
	disabled: z.boolean(),
	comments: z.string().nullish(),
	rData: z.record(z.string(), z.unknown()),
});

const ResolveResult = z.object({
	result: z.object({
		RCODE: z.string(),
		EDNS: z
			.object({
				Options: z
					.array(
						z.object({
							Data: z.object({ InfoCode: z.string().optional() }).loose(),
						}),
					)
					.optional(),
			})
			.optional(),
		Answer: z.array(
			z.object({
				Type: z.string(),
				RDATA: z.record(z.string(), z.unknown()),
			}),
		),
	}),
});

/** Extended DNS error codes Technitium attaches to an answer it filtered (RFC 8914). */
const BLOCKED_CODES = new Set(["Blocked", "Censored", "Filtered"]);

type RecordKey = Pick<HomeDnsRecord, "name" | "type" | "content">;

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** A Technitium rData in the presentation format of `contracts/dns.ts`. */
function contentOf(
	type: HomeDnsRecordType,
	d: Record<string, unknown>,
): string {
	switch (type) {
		case "A":
		case "AAAA":
			return str(d.ipAddress);
		case "CNAME":
			return str(d.cname);
		case "PTR":
			return str(d.ptrName);
		case "TXT":
			return str(d.text);
		case "MX":
			return `${str(d.preference)} ${str(d.exchange)}`;
		case "SRV":
			return `${str(d.priority)} ${str(d.weight)} ${str(d.port)} ${str(d.target)}`;
	}
}

/** The parameters naming a record's value in add, update (`prefix: "new"`) and delete calls. */
function valueParams(
	type: HomeDnsRecordType,
	content: string,
	prefix = "",
): Record<string, string> {
	const key = (k: string) =>
		prefix ? `${prefix}${k[0]?.toUpperCase()}${k.slice(1)}` : k;
	if (type === "PTR") return { [key("ptrName")]: content };
	const p = parseDnsValue(type, content);
	switch (type) {
		case "A":
		case "AAAA":
			return { [key("ipAddress")]: p.address ?? "" };
		// The update call takes the new CNAME target under its plain name.
		case "CNAME":
			return { cname: p.target ?? "" };
		case "TXT":
			return { [key("text")]: p.text ?? "" };
		case "MX":
			return {
				[key("preference")]: p.priority ?? "",
				[key("exchange")]: p.target ?? "",
			};
		case "SRV":
			return {
				[key("priority")]: p.priority ?? "",
				[key("weight")]: p.weight ?? "",
				[key("port")]: p.port ?? "",
				[key("target")]: p.target ?? "",
			};
	}
}

const lines = (text: string) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));

/**
 * Technitium DNS Server's HTTP API (v15). Every call is a form-encoded POST so passwords and
 * tokens never land in a URL; the token travels in the `Authorization` header.
 */
export function technitium(baseUrl: string, token?: string, deps?: Deps) {
	const http = new Http("technitium", deps);
	const base = baseUrl.replace(/\/$/, "");

	async function raw(
		op: string,
		path: string,
		params: Record<string, string> = {},
		timeoutMs?: number,
	): Promise<Response> {
		const h = timeoutMs ? new Http("technitium", { ...deps, timeoutMs }) : http;
		return h.request(op, `${base}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: new URLSearchParams(params),
		});
	}

	async function call<S extends z.ZodType>(
		op: string,
		path: string,
		schema: S,
		params?: Record<string, string>,
		timeoutMs?: number,
	): Promise<z.infer<S>> {
		const body = Envelope.parse(
			await (await raw(op, path, params, timeoutMs)).json(),
		);
		if (body.status !== "ok")
			throw new TechnitiumError(
				op,
				body.errorMessage ?? body.status,
				body.status === "invalid-token",
			);
		return schema.parse(body.response ?? {});
	}

	/** Allowed and blocked zones export as plain text; an invalid token still answers JSON. */
	async function exported(op: string, path: string): Promise<string[]> {
		const res = await raw(op, path);
		const text = await res.text();
		if (res.headers.get("content-type")?.includes("json")) {
			const body = Envelope.parse(JSON.parse(text));
			throw new TechnitiumError(
				op,
				body.errorMessage ?? body.status,
				body.status === "invalid-token",
			);
		}
		return lines(text);
	}

	const ok = z.unknown();

	async function addRecord(zone: string, r: HomeDnsRecordInput): Promise<void> {
		await call("addRecord", "/api/zones/records/add", ok, {
			zone,
			domain: r.name,
			type: r.type,
			ttl: String(r.ttl),
			...(r.comment ? { comments: r.comment } : {}),
			...valueParams(r.type, r.content),
		});
	}

	async function deleteRecord(zone: string, r: RecordKey): Promise<void> {
		await call("deleteRecord", "/api/zones/records/delete", ok, {
			zone,
			domain: r.name,
			type: r.type,
			...valueParams(r.type, r.content),
		});
	}

	return {
		/** Needs no token: proves the API answers. */
		async ping(): Promise<void> {
			await raw("status", "/api/status");
		},

		async login(user: string, pass: string): Promise<string> {
			const res = Envelope.extend({ token: z.string().optional() }).parse(
				await (await raw("login", "/api/user/login", { user, pass })).json(),
			);
			if (res.status !== "ok" || !res.token)
				throw new TechnitiumError(
					"login",
					res.errorMessage ?? res.status,
					false,
				);
			return res.token;
		},

		/** A non-expiring token for the session's user; needs a session token. */
		async createToken(tokenName: string): Promise<string> {
			const res = Envelope.extend({ token: z.string().optional() }).parse(
				await (
					await raw("createToken", "/api/user/createToken", { tokenName })
				).json(),
			);
			if (res.status !== "ok" || !res.token)
				throw new TechnitiumError(
					"createToken",
					res.errorMessage ?? res.status,
					res.status === "invalid-token",
				);
			return res.token;
		},

		async version(): Promise<string> {
			return (
				await call(
					"settings",
					"/api/settings/get",
					z.object({ version: z.string() }),
				)
			).version;
		},

		async applySettings(s: HomeDnsSettings): Promise<void> {
			await call("setSettings", "/api/settings/set", ok, {
				forwarders: s.upstream.servers.join(","),
				forwarderProtocol: s.upstream.protocol,
				dnssecValidation: String(s.dnssecValidation),
				enableBlocking: String(s.blocking.enabled),
				// `false` clears the list; an empty value would leave it as it was.
				blockListUrls: s.blocking.listUrls.length
					? s.blocking.listUrls.join(",")
					: "false",
			});
		},

		async forceUpdateBlockLists(): Promise<void> {
			await call(
				"forceUpdateBlockLists",
				"/api/settings/forceUpdateBlockLists",
				ok,
			);
		},

		async stats(range: HomeDnsStatsRange): Promise<HomeDnsStats> {
			const r = await call("stats", "/api/dashboard/stats/get", Stats, {
				type: ranges[range],
				utc: "true",
			});
			return {
				totals: {
					queries: r.stats.totalQueries,
					noError: r.stats.totalNoError,
					serverFailure: r.stats.totalServerFailure,
					nxDomain: r.stats.totalNxDomain,
					refused: r.stats.totalRefused,
					authoritative: r.stats.totalAuthoritative,
					recursive: r.stats.totalRecursive,
					cached: r.stats.totalCached,
					blocked: r.stats.totalBlocked,
					dropped: r.stats.totalDropped,
					clients: r.stats.totalClients,
				},
				chart: {
					labels: r.mainChartData.labels,
					series: r.mainChartData.datasets,
				},
				topClients: r.topClients,
				topDomains: r.topDomains,
				topBlocked: r.topBlockedDomains,
			};
		},

		async queryLogs(q: HomeDnsLogQuery): Promise<HomeDnsLogPage> {
			const params: Record<string, string> = {
				name: QUERY_LOG_APP.name,
				classPath: QUERY_LOG_APP.classPath,
				pageNumber: String(q.page),
				entriesPerPage: String(q.perPage),
				descendingOrder: "true",
			};
			if (q.client) params.clientIpAddress = q.client;
			if (q.domain) params.qname = q.domain;
			if (q.responseType) params.responseType = q.responseType;
			if (q.start) params.start = q.start;
			if (q.end) params.end = q.end;
			const r = await call("queryLogs", "/api/logs/query", LogPage, params);
			return {
				page: r.pageNumber,
				totalPages: r.totalPages,
				totalEntries: r.totalEntries,
				entries: r.entries.map((e) => ({
					timestamp: e.timestamp,
					client: e.clientIpAddress,
					protocol: e.protocol,
					responseType: e.responseType,
					rcode: e.rcode,
					domain: e.qname ?? "",
					type: e.qtype ?? "",
					answer: e.answer ?? "",
					rttMs: e.responseRtt ?? null,
				})),
			};
		},

		async apps(): Promise<{ name: string; version: string }[]> {
			return (
				await call(
					"apps",
					"/api/apps/list",
					z.object({
						apps: z.array(z.object({ name: z.string(), version: z.string() })),
					}),
				)
			).apps;
		},

		async storeApps(): Promise<{ name: string; url: string }[]> {
			return (
				await call(
					"storeApps",
					"/api/apps/listStoreApps",
					z.object({
						storeApps: z.array(z.object({ name: z.string(), url: z.string() })),
					}),
				)
			).storeApps;
		},

		/** Technitium downloads the zip itself, which can take many minutes on a slow link. */
		async installApp(
			name: string,
			url: string,
			timeoutMs: number,
		): Promise<void> {
			await call(
				"installApp",
				"/api/apps/downloadAndInstall",
				ok,
				{ name, url },
				timeoutMs,
			);
		},

		allowed: () => exported("allowed", "/api/allowed/export"),
		allow: async (domain: string) => {
			await call("allow", "/api/allowed/add", ok, { domain });
		},
		disallow: async (domain: string) => {
			await call("disallow", "/api/allowed/delete", ok, { domain });
		},
		blocked: () => exported("blocked", "/api/blocked/export"),
		block: async (domain: string) => {
			await call("block", "/api/blocked/add", ok, { domain });
		},
		unblock: async (domain: string) => {
			await call("unblock", "/api/blocked/delete", ok, { domain });
		},

		/** Zones LogiStack users see; Technitium's built-in reverse and localhost zones are hidden. */
		async zones(): Promise<HomeDnsZone[]> {
			const r = await call(
				"zones",
				"/api/zones/list",
				z.object({
					zones: z.array(
						z.object({
							name: z.string(),
							type: z.string(),
							internal: z.boolean().optional(),
							disabled: z.boolean(),
						}),
					),
				}),
			);
			return r.zones
				.filter((zone) => !zone.internal)
				.map(({ name, type, disabled }) => ({ name, type, disabled }));
		},

		async createZone(name: string): Promise<void> {
			await call("createZone", "/api/zones/create", ok, {
				zone: name,
				type: "Primary",
			});
		},

		async deleteZone(name: string): Promise<void> {
			await call("deleteZone", "/api/zones/delete", ok, { zone: name });
		},

		/** Records of the types LogiStack edits; the rest (SOA, NS, ...) stay in the console. */
		async records(zone: string): Promise<HomeDnsRecord[]> {
			const r = await call(
				"records",
				"/api/zones/records/get",
				z.object({ records: z.array(RecordRow) }),
				{ domain: zone, zone, listZone: "true" },
			);
			return r.records.flatMap((row) => {
				const type = HomeDnsRecordType.safeParse(row.type);
				if (!type.success) return [];
				const content = contentOf(type.data, row.rData);
				return [
					{
						id: homeDnsRecordId({ name: row.name, type: type.data, content }),
						name: row.name,
						type: type.data,
						content,
						ttl: row.ttl,
						...(row.comments ? { comment: row.comments } : {}),
						disabled: row.disabled,
					},
				];
			});
		},

		addRecord,

		/** Technitium updates in place only within one type; a type change re-creates the record. */
		async updateRecord(
			zone: string,
			current: RecordKey,
			next: HomeDnsRecordInput,
		): Promise<void> {
			if (current.type !== next.type) {
				await addRecord(zone, next);
				await deleteRecord(zone, current);
				return;
			}
			await call("updateRecord", "/api/zones/records/update", ok, {
				zone,
				domain: current.name,
				type: current.type,
				newDomain: next.name,
				ttl: String(next.ttl),
				comments: next.comment ?? "",
				...valueParams(current.type, current.content),
				...valueParams(next.type, next.content, "new"),
			});
		},

		deleteRecord,

		/** Asks Technitium itself, so blocking and local zones apply as they would for a device. */
		async resolve(name: string): Promise<HomeDnsTestResult> {
			const r = await call("resolve", "/api/dnsClient/resolve", ResolveResult, {
				server: "this-server",
				domain: name,
				type: "A",
			});
			return {
				name,
				blocked: (r.result.EDNS?.Options ?? []).some((o) =>
					BLOCKED_CODES.has(o.Data.InfoCode ?? ""),
				),
				rcode: r.result.RCODE,
				answers: r.result.Answer.map((a) => ({
					type: a.Type,
					data: Object.values(a.RDATA).map(str).join(" "),
				})),
			};
		},
	};
}

export type Technitium = ReturnType<typeof technitium>;
