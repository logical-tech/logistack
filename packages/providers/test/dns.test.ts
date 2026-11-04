import { describe, expect, test } from "bun:test";
import {
	dnsRecordSetIssues,
	dnsValueIssues,
	formatDnsValue,
	parseDnsValue,
} from "@logistack/contracts";
import {
	caddyDnsChallenge,
	cloudflare,
	findZoneForHostname,
	Http,
	hetzner,
	instantiate,
	ProviderError,
	route53,
	signV4,
	waitForPropagation,
} from "../src/index.ts";
import { json, mockFetch } from "./helpers.ts";

describe("SigV4 against the AWS signing test suite", () => {
	// Vectors from awslabs/aws-c-auth tests/aws-signing-test-suite/v4.
	const opts = {
		credentials: {
			accessKeyId: "AKIDEXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		},
		region: "us-east-1",
		service: "service",
		now: new Date("2015-08-30T12:36:00Z"),
	};
	const auth = (signedHeaders: string, signature: string) =>
		`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	test("get-vanilla", async () => {
		const h = await signV4(
			{ method: "GET", url: "https://example.amazonaws.com/" },
			opts,
		);
		expect(h["x-amz-date"]).toBe("20150830T123600Z");
		expect(h.authorization).toBe(
			auth(
				"host;x-amz-date",
				"5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
			),
		);
	});

	test("get-vanilla-query-order-key-case", async () => {
		const h = await signV4(
			{
				method: "GET",
				url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
			},
			opts,
		);
		expect(h.authorization).toBe(
			auth(
				"host;x-amz-date",
				"b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
			),
		);
	});

	test("get-vanilla-query-unreserved", async () => {
		const u =
			"-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
		const h = await signV4(
			{ method: "GET", url: `https://example.amazonaws.com/?${u}=${u}` },
			opts,
		);
		expect(h.authorization).toBe(
			auth(
				"host;x-amz-date",
				"9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197",
			),
		);
	});

	test("post-x-www-form-urlencoded", async () => {
		const h = await signV4(
			{
				method: "POST",
				url: "https://example.amazonaws.com/",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"Content-Length": "13",
					"x-amz-content-sha256":
						"9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
				},
				body: "Param1=value1",
			},
			opts,
		);
		expect(h.authorization).toBe(
			auth(
				"content-length;content-type;host;x-amz-content-sha256;x-amz-date",
				"d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
			),
		);
	});
});

describe("caddyDnsChallenge", () => {
	test("emits the field names each caddy-dns module reads", () => {
		expect(caddyDnsChallenge("cloudflare", { apiToken: "cf" })).toEqual({
			name: "cloudflare",
			api_token: "cf",
		});
		expect(caddyDnsChallenge("hetzner", { apiToken: "hz" })).toEqual({
			name: "hetzner",
			api_token: "hz",
		});
		expect(
			caddyDnsChallenge(
				"route53",
				route53.configSchema.parse({
					accessKeyId: "AK",
					secretAccessKey: "SK",
				}),
			),
		).toEqual({
			name: "route53",
			access_key_id: "AK",
			secret_access_key: "SK",
			region: "us-east-1",
		});
	});
});

describe("findZoneForHostname", () => {
	const zones = [
		{ id: "1", name: "example.com" },
		{ id: "2", name: "app.example.com" },
		{ id: "3", name: "ample.com" },
	];
	test("longest suffix wins", () => {
		expect(findZoneForHostname("api.app.example.com", zones)?.id).toBe("2");
		expect(findZoneForHostname("www.example.com", zones)?.id).toBe("1");
		expect(findZoneForHostname("*.app.example.com", zones)?.id).toBe("2");
	});
	test("apex, case and trailing dot", () => {
		expect(findZoneForHostname("Example.COM.", zones)?.id).toBe("1");
	});
	test("a suffix must start at a label boundary", () => {
		expect(findZoneForHostname("example.org", zones)).toBeUndefined();
		expect(findZoneForHostname("sample.com", zones)).toBeUndefined();
	});
});

describe("Http", () => {
	test("timeouts become ProviderError", async () => {
		const http = new Http("x", {
			timeoutMs: 20,
			fetch: (_u, init) =>
				new Promise((_, reject) =>
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					),
				),
		});
		const err = await http.request("op", "https://example.com").catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.message).toBe("x op: timed out after 20ms");
	});
	test("non-2xx carries status and body, never the URL", async () => {
		const http = new Http("telegram", {
			fetch: async () => new Response("bad chat", { status: 400 }),
		});
		const err = await http
			.request("send", "https://api.telegram.org/botSECRET/sendMessage")
			.catch((e) => e);
		expect(err).toMatchObject({
			provider: "telegram",
			op: "send",
			status: 400,
		});
		expect(err.message).not.toContain("SECRET");
	});
});

describe("cloudflare", () => {
	const record = (id: string, content: string) => ({
		id,
		name: "app.example.com",
		type: "A" as const,
		content,
		ttl: 300,
		proxied: false,
	});

	test("upsert updates the first match and removes duplicates", async () => {
		const m = mockFetch((c) => {
			if (c.method === "GET")
				return Response.json({
					result: [record("r1", "1.1.1.1"), record("r2", "2.2.2.2")],
					result_info: { total_pages: 1 },
				});
			return Response.json({ result: record("r1", "9.9.9.9") });
		});
		const dns = instantiate(cloudflare, { apiToken: "tok" }, m);
		const saved = await dns.upsertRecord({
			zoneId: "z1",
			name: "App.Example.com",
			type: "A",
			content: "9.9.9.9",
			ttl: 300,
		});
		expect(saved).toEqual({ ...record("r1", "9.9.9.9"), zoneId: "z1" });
		expect(
			m.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
		).toEqual([
			"GET /client/v4/zones/z1/dns_records",
			"PUT /client/v4/zones/z1/dns_records/r1",
			"DELETE /client/v4/zones/z1/dns_records/r2",
		]);
		expect(new URL(m.calls[0]?.url ?? "").searchParams.get("name")).toBe(
			"app.example.com",
		);
		expect(m.calls[0]?.headers.authorization).toBe("Bearer tok");
		expect(json(m.calls[1] ?? ({} as never))).toEqual({
			type: "A",
			name: "app.example.com",
			content: "9.9.9.9",
			ttl: 300,
			proxied: false,
		});
	});

	test("upsert creates when nothing matches", async () => {
		const m = mockFetch((c) =>
			c.method === "GET"
				? Response.json({ result: [], result_info: { total_pages: 1 } })
				: Response.json({ result: record("new", "1.2.3.4") }),
		);
		const dns = cloudflare.create({ apiToken: "t" }, m);
		await dns.upsertRecord({
			zoneId: "z1",
			name: "app.example.com",
			type: "A",
			content: "1.2.3.4",
			ttl: 1,
		});
		expect(m.calls[1]?.method).toBe("POST");
	});

	test("listZones follows pagination", async () => {
		const m = mockFetch((c) => {
			const page = Number(new URL(c.url).searchParams.get("page"));
			return Response.json({
				result: [{ id: `z${page}`, name: `Zone${page}.com` }],
				result_info: { total_pages: 2 },
			});
		});
		expect(await cloudflare.create({ apiToken: "t" }, m).listZones()).toEqual([
			{ id: "z1", name: "zone1.com" },
			{ id: "z2", name: "zone2.com" },
		]);
	});

	test("MX, SRV and CAA travel in Cloudflare's priority/data fields", async () => {
		const m = mockFetch((c) => {
			if (c.method === "GET")
				return Response.json({
					result: [
						{
							id: "mx",
							name: "example.com",
							type: "MX",
							content: "mail.example.com",
							priority: 10,
							ttl: 1,
							comment: "primary",
						},
						{
							id: "srv",
							name: "_sip._tcp.example.com",
							type: "SRV",
							content: "5 5060 sip.example.com",
							priority: 10,
							data: {
								priority: 10,
								weight: 5,
								port: 5060,
								target: "sip.example.com",
							},
							ttl: 300,
						},
						{
							id: "caa",
							name: "example.com",
							type: "CAA",
							content: '0 issue "letsencrypt.org"',
							data: { flags: 0, tag: "issue", value: "letsencrypt.org" },
							ttl: 300,
						},
						{
							id: "soa",
							name: "example.com",
							type: "SOA",
							content: "x",
							ttl: 1,
						},
					],
					result_info: { total_pages: 1 },
				});
			return Response.json({ result: { ...(json(c) as object), id: "new" } });
		});
		const dns = cloudflare.create({ apiToken: "t" }, m);
		expect(
			(await dns.listRecords("z")).map((r) => [r.type, r.content, r.comment]),
		).toEqual([
			["MX", "10 mail.example.com", "primary"],
			["SRV", "10 5 5060 sip.example.com", undefined],
			["CAA", '0 issue "letsencrypt.org"', undefined],
		]);

		const [mx] = await dns.createRecord({
			zoneId: "z",
			name: "Example.com",
			type: "MX",
			ttl: 1,
			values: ["20 backup.example.com."],
			comment: "backup",
		});
		expect(json(m.calls.at(-1) ?? ({} as never))).toEqual({
			type: "MX",
			name: "example.com",
			ttl: 1,
			priority: 20,
			content: "backup.example.com",
			comment: "backup",
		});
		expect(mx?.content).toBe("20 backup.example.com");

		await dns.updateRecord("srv", {
			zoneId: "z",
			name: "_sip._tcp.example.com",
			type: "SRV",
			ttl: 300,
			values: ["10 5 5061 sip.example.com"],
		});
		const put = m.calls.at(-1);
		expect(`${put?.method} ${new URL(put?.url ?? "").pathname}`).toBe(
			"PUT /client/v4/zones/z/dns_records/srv",
		);
		expect(json(put ?? ({} as never))).toMatchObject({
			data: { priority: 10, weight: 5, port: 5061, target: "sip.example.com" },
		});

		await dns.createRecord({
			zoneId: "z",
			name: "app.example.com",
			type: "A",
			ttl: 1,
			values: ["1.2.3.4"],
			proxied: true,
		});
		expect(json(m.calls.at(-1) ?? ({} as never))).toMatchObject({
			proxied: true,
			content: "1.2.3.4",
		});
	});

	test("a Cloudflare record holds one value", async () => {
		const m = mockFetch();
		const err = await cloudflare
			.create({ apiToken: "t" }, m)
			.createRecord({
				zoneId: "z",
				name: "a.example.com",
				type: "A",
				ttl: 1,
				values: ["1.1.1.1", "2.2.2.2"],
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect(m.calls).toHaveLength(0);
	});

	test("deleting a missing record succeeds", async () => {
		const m = mockFetch(() => new Response("{}", { status: 404 }));
		await cloudflare.create({ apiToken: "t" }, m).deleteRecord("z", "r");
	});
});

describe("hetzner", () => {
	const zone = () =>
		Response.json({ zone: { name: "example.com", ttl: 3600 } });

	test("upsert creates a missing rrset with relative name and quoted TXT", async () => {
		const m = mockFetch((c) => {
			const path = new URL(c.url).pathname;
			if (path === "/v1/zones/42") return zone();
			if (c.method === "GET") return new Response("not found", { status: 404 });
			return Response.json({});
		});
		const saved = await hetzner.create({ apiToken: "t" }, m).upsertRecord({
			zoneId: "42",
			name: "_verify.example.com",
			type: "TXT",
			content: 'a "quoted" token',
			ttl: 60,
		});
		expect(saved.id).toBe("_verify/TXT");
		const post = m.calls.at(-1);
		expect(new URL(post?.url ?? "").pathname).toBe("/v1/zones/42/rrsets");
		expect(json(post ?? ({} as never))).toEqual({
			name: "_verify",
			type: "TXT",
			ttl: 60,
			records: [{ value: '"a \\"quoted\\" token"' }],
		});
	});

	test("upsert replaces records and TTL of an existing rrset", async () => {
		const m = mockFetch((c) => {
			const path = new URL(c.url).pathname;
			if (path === "/v1/zones/42") return zone();
			if (c.method === "GET")
				return Response.json({
					rrset: {
						name: "@",
						type: "A",
						ttl: 300,
						records: [{ value: "1.1.1.1" }],
					},
				});
			return Response.json({});
		});
		await hetzner.create({ apiToken: "t" }, m).upsertRecord({
			zoneId: "42",
			name: "example.com",
			type: "A",
			content: "2.2.2.2",
			ttl: 60,
		});
		expect(m.calls.slice(2).map((c) => new URL(c.url).pathname)).toEqual([
			"/v1/zones/42/rrsets/%40/A/actions/set_records",
			"/v1/zones/42/rrsets/%40/A/actions/change_ttl",
		]);
	});

	test("listRecords flattens rrsets and skips other types", async () => {
		const m = mockFetch((c) =>
			new URL(c.url).pathname === "/v1/zones/42"
				? zone()
				: Response.json({
						rrsets: [
							{
								name: "www",
								type: "A",
								ttl: null,
								records: [{ value: "1.1.1.1" }, { value: "2.2.2.2" }],
							},
							{ name: "@", type: "SOA", ttl: 60, records: [{ value: "x" }] },
							{
								name: "@",
								type: "TXT",
								ttl: 60,
								records: [{ value: '"v=spf1" " -all"' }],
							},
						],
						meta: { pagination: { next_page: null } },
					}),
		);
		expect(
			await hetzner.create({ apiToken: "t" }, m).listRecords("42"),
		).toEqual([
			{
				id: "www/A",
				zoneId: "42",
				name: "www.example.com",
				type: "A",
				content: "1.1.1.1",
				ttl: 3600,
			},
			{
				id: "www/A",
				zoneId: "42",
				name: "www.example.com",
				type: "A",
				content: "2.2.2.2",
				ttl: 3600,
			},
			{
				id: "@/TXT",
				zoneId: "42",
				name: "example.com",
				type: "TXT",
				content: "v=spf1 -all",
				ttl: 60,
			},
		]);
	});

	test("create writes absolute targets; reads strip the dot and flag protected sets", async () => {
		const m = mockFetch((c) => {
			const path = new URL(c.url).pathname;
			if (path === "/v1/zones/42") return zone();
			if (c.method === "GET")
				return Response.json({
					rrsets: [
						{
							name: "@",
							type: "MX",
							ttl: 300,
							records: [{ value: "10 mx.example.com." }],
						},
						{
							name: "@",
							type: "NS",
							ttl: 3600,
							records: [{ value: "hydrogen.ns.hetzner.com." }],
							protection: { change: true },
						},
					],
				});
			return Response.json({});
		});
		const dns = hetzner.create({ apiToken: "t" }, m);
		await dns.createRecord({
			zoneId: "42",
			name: "example.com",
			type: "MX",
			ttl: 300,
			values: ["10 mx.example.com", "20 backup.example.net"],
		});
		expect(json(m.calls.at(-1) ?? ({} as never))).toEqual({
			name: "@",
			type: "MX",
			ttl: 300,
			records: [
				{ value: "10 mx.example.com." },
				{ value: "20 backup.example.net." },
			],
		});
		const [mx, ns] = await dns.listRecords("42");
		expect(mx?.content).toBe("10 mx.example.com");
		expect(ns?.readOnly).toStartWith("Protected at Hetzner");
	});

	test("update renames by creating the new rrset, then deleting the old", async () => {
		const m = mockFetch((c) =>
			new URL(c.url).pathname === "/v1/zones/42" ? zone() : Response.json({}),
		);
		const records = await hetzner
			.create({ apiToken: "t" }, m)
			.updateRecord("www/CNAME", {
				zoneId: "42",
				name: "web.example.com",
				type: "CNAME",
				ttl: 600,
				values: ["app.example.net"],
			});
		expect(records[0]?.id).toBe("web/CNAME");
		expect(
			m.calls.slice(1).map((c) => `${c.method} ${new URL(c.url).pathname}`),
		).toEqual([
			"GET /v1/zones/42",
			"POST /v1/zones/42/rrsets",
			"DELETE /v1/zones/42/rrsets/www/CNAME",
		]);
	});

	test("rejects names outside the zone", async () => {
		const m = mockFetch(() => zone());
		const err = await hetzner
			.create({ apiToken: "t" }, m)
			.upsertRecord({
				zoneId: "42",
				name: "evil.org",
				type: "A",
				content: "1.1.1.1",
				ttl: 60,
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
	});
});

describe("route53", () => {
	const config = { accessKeyId: "AK", secretAccessKey: "SK" };

	test("listZones parses XML and pages by marker", async () => {
		const m = mockFetch((c) =>
			new URL(c.url).searchParams.get("marker")
				? new Response(
						"<ListHostedZonesResponse><HostedZones><HostedZone><Id>/hostedzone/Z2</Id><Name>b.example.</Name></HostedZone></HostedZones><IsTruncated>false</IsTruncated></ListHostedZonesResponse>",
					)
				: new Response(
						"<ListHostedZonesResponse><HostedZones><HostedZone><Id>/hostedzone/Z1</Id><Name>a.example.</Name></HostedZone></HostedZones><IsTruncated>true</IsTruncated><NextMarker>Z2</NextMarker></ListHostedZonesResponse>",
					),
		);
		const dns = instantiate(route53, config, m);
		expect(await dns.listZones()).toEqual([
			{ id: "Z1", name: "a.example" },
			{ id: "Z2", name: "b.example" },
		]);
		expect(m.calls[0]?.headers.authorization).toStartWith(
			"AWS4-HMAC-SHA256 Credential=AK/",
		);
		expect(m.calls[0]?.headers.authorization).toContain(
			"/us-east-1/route53/aws4_request",
		);
	});

	const sets =
		"<ListResourceRecordSetsResponse><ResourceRecordSets>" +
		"<ResourceRecordSet><Name>\\052.app.example.com.</Name><Type>A</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>1.1.1.1</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>" +
		"<ResourceRecordSet><Name>\\052.app.example.com.</Name><Type>TXT</Type><TTL>60</TTL><ResourceRecords><ResourceRecord><Value>&quot;hello&quot;</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>" +
		"<ResourceRecordSet><Name>\\052.app.example.com.</Name><Type>AAAA</Type><AliasTarget><DNSName>x</DNSName></AliasTarget></ResourceRecordSet>" +
		"</ResourceRecordSets><IsTruncated>false</IsTruncated></ListResourceRecordSetsResponse>";

	test("listRecords decodes names, unquotes TXT, lists alias sets read-only", async () => {
		const m = mockFetch(() => new Response(sets));
		const records = await route53
			.create(route53.configSchema.parse(config), m)
			.listRecords("Z1", "*.app.example.com");
		expect(records).toEqual([
			{
				id: "*.app.example.com/A",
				zoneId: "Z1",
				name: "*.app.example.com",
				type: "A",
				content: "1.1.1.1",
				ttl: 300,
			},
			{
				id: "*.app.example.com/TXT",
				zoneId: "Z1",
				name: "*.app.example.com",
				type: "TXT",
				content: "hello",
				ttl: 60,
			},
			{
				id: "*.app.example.com/AAAA#ro",
				zoneId: "Z1",
				name: "*.app.example.com",
				type: "AAAA",
				content: "x",
				ttl: 0,
				readOnly: "Alias to an AWS resource, edit it in the AWS console",
			},
		]);
	});

	test("create sends a CREATE batch with every value, long TXT split in 255-char strings", async () => {
		const m = mockFetch(() => new Response("<ChangeInfo/>"));
		const dns = route53.create(route53.configSchema.parse(config), m);
		const long = "k".repeat(300);
		const saved = await dns.createRecord({
			zoneId: "Z1",
			name: "s._domainkey.example.com",
			type: "TXT",
			ttl: 300,
			values: [long, "short"],
		});
		expect(saved.map((r) => r.content)).toEqual([long, "short"]);
		expect(saved[0]?.id).toBe("s._domainkey.example.com/TXT");
		const body = m.calls[0]?.body ?? "";
		expect(body).toContain("<Action>CREATE</Action>");
		expect(body).toContain(
			`<Value>&quot;${"k".repeat(255)}&quot; &quot;${"k".repeat(45)}&quot;</Value>`,
		);
		expect(body).toContain("<Value>&quot;short&quot;</Value>");
	});

	test("update in place is an UPSERT; a rename deletes and creates in one batch", async () => {
		const m = mockFetch((c) =>
			c.method === "GET" ? new Response(sets) : new Response("<ChangeInfo/>"),
		);
		const dns = route53.create(route53.configSchema.parse(config), m);
		const input = {
			zoneId: "Z1",
			name: "*.app.example.com",
			type: "A" as const,
			ttl: 60,
			values: ["1.1.1.1", "2.2.2.2"],
		};
		await dns.updateRecord("*.app.example.com/A", input);
		expect(m.calls).toHaveLength(1);
		expect(m.calls[0]?.body).toContain("<Action>UPSERT</Action>");
		await dns.updateRecord("*.app.example.com/A", {
			...input,
			name: "web.example.com",
		});
		const batch = m.calls.at(-1)?.body ?? "";
		expect(batch.indexOf("<Action>DELETE</Action>")).toBeLessThan(
			batch.indexOf("<Action>CREATE</Action>"),
		);
		expect(batch).toContain("<Name>*.app.example.com.</Name>");
		expect(batch).toContain("<Name>web.example.com.</Name>");
	});

	test("MX targets lose their trailing dot on read", async () => {
		const m = mockFetch(
			() =>
				new Response(
					"<ListResourceRecordSetsResponse><ResourceRecordSets><ResourceRecordSet><Name>example.com.</Name><Type>MX</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>10 mx.example.com.</Value></ResourceRecord></ResourceRecords></ResourceRecordSet><ResourceRecordSet><Name>example.com.</Name><Type>NS</Type><TTL>172800</TTL><ResourceRecords><ResourceRecord><Value>ns-1.awsdns-01.org.</Value></ResourceRecord></ResourceRecords></ResourceRecordSet></ResourceRecordSets><IsTruncated>false</IsTruncated></ListResourceRecordSetsResponse>",
				),
		);
		const [mx, ns] = await route53
			.create(route53.configSchema.parse(config), m)
			.listRecords("Z1");
		expect(mx?.content).toBe("10 mx.example.com");
		expect(ns?.readOnly).toBe("The hosted zone's own name servers");
	});

	test("upsert sends an UPSERT change batch", async () => {
		const m = mockFetch(() => new Response("<ChangeInfo/>"));
		await route53.create(route53.configSchema.parse(config), m).upsertRecord({
			zoneId: "Z1",
			name: "app.example.com",
			type: "TXT",
			content: "a<b",
			ttl: 60,
		});
		const c = m.calls[0];
		expect(c?.method).toBe("POST");
		expect(new URL(c?.url ?? "").pathname).toBe(
			"/2013-04-01/hostedzone/Z1/rrset/",
		);
		expect(c?.body).toContain(
			"<Action>UPSERT</Action><ResourceRecordSet><Name>app.example.com.</Name><Type>TXT</Type><TTL>60</TTL><ResourceRecords><ResourceRecord><Value>&quot;a&lt;b&quot;</Value></ResourceRecord>",
		);
	});

	test("delete repeats the current values, and is a no-op when gone", async () => {
		const m = mockFetch((c) =>
			c.method === "GET" ? new Response(sets) : new Response("<ChangeInfo/>"),
		);
		const dns = route53.create(route53.configSchema.parse(config), m);
		await dns.deleteRecord("Z1", "*.app.example.com/A");
		expect(m.calls[1]?.body).toContain("<Action>DELETE</Action>");
		expect(m.calls[1]?.body).toContain("<Value>1.1.1.1</Value>");
		await dns.deleteRecord("Z1", "*.app.example.com/CNAME");
		expect(m.calls).toHaveLength(3);
	});

	test("AWS errors surface Code and Message", async () => {
		const m = mockFetch(
			() =>
				new Response(
					"<ErrorResponse><Error><Type>Sender</Type><Code>InvalidChangeBatch</Code><Message>bad &amp; wrong</Message></Error></ErrorResponse>",
					{ status: 400 },
				),
		);
		const err = await route53
			.create(route53.configSchema.parse(config), m)
			.verify()
			.catch((e) => e);
		expect(err.message).toBe("route53 verify: InvalidChangeBatch: bad & wrong");
		expect(err.status).toBe(400);
	});
});

describe("waitForPropagation", () => {
	test("polls with backoff until every resolver answers", async () => {
		let googleCalls = 0;
		const sleeps: number[] = [];
		const m = mockFetch((c) => {
			const google = c.url.startsWith("https://dns.google");
			if (google) googleCalls++;
			const visible = !google || googleCalls >= 3;
			return Response.json({
				Answer: visible ? [{ type: 16, data: '"tok"' }] : [],
			});
		});
		await waitForPropagation(
			"_acme.example.com",
			{ type: "TXT", content: "tok" },
			undefined,
			{
				fetch: m.fetch,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			},
		);
		expect(sleeps).toEqual([2000, 4000]);
		expect(
			m.calls.filter((c) => !c.url.startsWith("https://dns.google")),
		).toHaveLength(1);
		expect(m.calls[0]?.headers.accept).toBe("application/dns-json");
	});

	test("gives up at the deadline", async () => {
		let t = 0;
		const m = mockFetch(() =>
			Response.json({ Answer: [{ type: 1, data: "1.1.1.1" }] }),
		);
		const err = await waitForPropagation(
			"a.example.com",
			{ type: "A", content: "2.2.2.2" },
			undefined,
			{
				fetch: m.fetch,
				timeoutMs: 10_000,
				now: () => t,
				sleep: async (ms) => {
					t += ms;
				},
			},
		).catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.op).toBe("waitForPropagation");
	});
});

describe("record values (contracts)", () => {
	test("parse and format round-trip, CAA quoting included", () => {
		const caa = formatDnsValue("CAA", {
			flags: "0",
			tag: "iodef",
			value: 'mailto:"x"',
		});
		expect(caa).toBe('0 iodef "mailto:\\"x\\""');
		expect(parseDnsValue("CAA", caa)).toEqual({
			flags: "0",
			tag: "iodef",
			value: 'mailto:"x"',
		});
		expect(parseDnsValue("SRV", "10 5 5060 sip.example.com")).toEqual({
			priority: "10",
			weight: "5",
			port: "5060",
			target: "sip.example.com",
		});
		expect(parseDnsValue("TXT", "v=spf1 a -all").text).toBe("v=spf1 a -all");
	});

	test("issues per type and per provider", () => {
		expect(dnsValueIssues("A", "1.2.3.4")).toEqual({});
		expect(dnsValueIssues("A", "1.2.3.256").address).toBeDefined();
		expect(dnsValueIssues("AAAA", "2001:db8::1")).toEqual({});
		expect(dnsValueIssues("AAAA", "2001:db8::g")).not.toEqual({});
		expect(dnsValueIssues("MX", "70000 mx.example.com").priority).toBeDefined();
		expect(dnsValueIssues("SRV", "0 0 443 .")).toEqual({});
		const base = {
			name: "example.com",
			type: "CNAME" as const,
			ttl: 1,
			values: ["a.example.net", "b.example.net"],
			proxied: true,
		};
		expect(
			dnsRecordSetIssues("cloudflare", "example.com", base).map(([p]) => p),
		).toEqual(["name", "values", "values"]);
		expect(
			dnsRecordSetIssues("hetzner", "example.com", {
				...base,
				type: "TXT",
				name: "x.example.org",
				ttl: 30,
				values: ["ok"],
			}).map(([p]) => p),
		).toEqual(["name", "ttl", "proxied"]);
	});
});
