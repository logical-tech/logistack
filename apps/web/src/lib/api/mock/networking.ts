import { ApiError } from "../adapter";
import type {
	AcmeDirectory,
	Channel,
	CustomCertificate,
	DnsProvider,
	DnsRecordSet,
	DnsZone,
	DomainListItem,
	ManagedCertificate,
	NetworkingApi,
	Rule,
} from "../networking";
import schemas from "./schemas.json";

const delay = <T>(value: T, ms = 220 + Math.random() * 380): Promise<T> =>
	new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const ago = (days: number) =>
	new Date(Date.now() - days * 86_400_000).toISOString();
const inDays = (days: number) =>
	new Date(Date.now() + days * 86_400_000).toISOString();

const IP = "49.12.88.7";

const providers: DnsProvider[] = [
	{
		id: "dns_cf_logical",
		kind: "cloudflare",
		name: "Cloudflare · Logical",
		zones: [
			{ id: "z_logical", name: "logical.it" },
			{ id: "z_acme", name: "acme-retail.it" },
		],
		domains: 5,
		createdAt: ago(120),
		updatedAt: ago(12),
	},
	{
		id: "dns_hz_nordwind",
		kind: "hetzner",
		name: "Hetzner · Nordwind",
		zones: [{ id: "z_nordwind", name: "nordwind.de" }],
		domains: 1,
		createdAt: ago(64),
		updatedAt: ago(64),
	},
];

const svc = (
	env: string,
	slug: string,
	project: string,
	projectName: string,
) => ({
	service: { id: `svc_${env}_${slug}`, name: slug },
	project: { id: `prj_${project}`, name: projectName },
	environment: {
		id: `env_${env}`,
		name: env.endsWith("staging")
			? "Staging"
			: env.endsWith("preview")
				? "Preview"
				: "Production",
	},
});

const row = (
	hostname: string,
	owner: ReturnType<typeof svc>,
	over: Partial<DomainListItem> = {},
): DomainListItem => ({
	id: rid("dom"),
	hostname,
	port: 3000,
	pathPrefix: null,
	https: true,
	cert: "auto",
	tls: "http-01",
	isGenerated: false,
	dnsProviderId: null,
	dnsRecordId: null,
	tunnel: false,
	customCertificateId: null,
	redirectTo: null,
	access: [],
	status: "active",
	statusMessage: null,
	certificate: null,
	createdAt: ago(40),
	...owner,
	...over,
});

const acmeWildcard = {
	source: "managed" as const,
	name: null,
	issuer: "E6",
	notAfter: inDays(61),
};

const domains: DomainListItem[] = [
	row(
		"shop.acme-retail.it",
		svc("storefront_production", "web", "storefront", "Storefront"),
		{
			tls: "dns-01",
			dnsProviderId: "dns_cf_logical",
			dnsRecordId: "rec_1",
			certificate: acmeWildcard,
		},
	),
	row(
		"api.acme-retail.it",
		svc("storefront_production", "api", "storefront", "Storefront"),
		{
			port: 8080,
			tls: "dns-01",
			dnsProviderId: "dns_cf_logical",
			dnsRecordId: "rec_2",
			certificate: acmeWildcard,
		},
	),
	row(
		"office.acme-retail.it",
		svc("backoffice_production", "app", "backoffice", "Back office"),
		{
			cert: "custom",
			tls: "custom",
			customCertificateId: "crt_acme_office",
			certificate: {
				source: "custom",
				name: "Acme office (Sectigo)",
				issuer: "Uploaded",
				notAfter: inDays(9),
			},
		},
	),
	row(
		"booking.nordwind.de",
		svc("booking_production", "api", "booking", "Booking API"),
		{
			port: 8080,
			tls: "dns-01",
			dnsProviderId: "dns_hz_nordwind",
			dnsRecordId: "booking/A",
			status: "error",
			statusMessage:
				"loading certificates: hetzner: HTTP 401 Unauthorized: invalid token",
		},
	),
	row(
		"studiorossi.it",
		svc("rossi_production", "site", "rossi", "Studio Rossi"),
		{
			certificate: {
				source: "managed",
				name: null,
				issuer: "R11",
				notAfter: inDays(34),
			},
		},
	),
	row(
		"cms.studiorossi.it",
		svc("rossi_production", "cms", "rossi", "Studio Rossi"),
		{
			status: "pending",
			createdAt: ago(0.01),
		},
	),
	row(
		"status.logical.it",
		svc("status_production", "uptime-kuma", "status", "Status page"),
		{
			tls: "dns-01",
			dnsProviderId: "dns_cf_logical",
			dnsRecordId: "rec_3",
			certificate: {
				source: "managed",
				name: null,
				issuer: "E5",
				notAfter: inDays(12),
			},
		},
	),
	row(
		"web-staging.49-12-88-7.sslip.io",
		svc("storefront_staging", "web", "storefront", "Storefront"),
		{
			isGenerated: true,
			https: false,
			cert: "none",
			tls: "none",
		},
	),
	row("logical.it", svc("website_production", "web", "website", "logical.it"), {
		port: 80,
		tls: "dns-01",
		dnsProviderId: "dns_cf_logical",
		dnsRecordId: "rec_4",
		certificate: {
			source: "managed",
			name: null,
			issuer: "E6",
			notAfter: inDays(77),
		},
	}),
	row(
		"www.logical.it",
		svc("website_production", "web", "website", "logical.it"),
		{
			port: 80,
			redirectTo: "logical.it",
			tls: "dns-01",
			dnsProviderId: "dns_cf_logical",
			dnsRecordId: "rec_5",
			certificate: {
				source: "managed",
				name: null,
				issuer: "E6",
				notAfter: inDays(77),
			},
		},
	),
];

const custom: CustomCertificate[] = [
	{
		id: "crt_acme_office",
		name: "Acme office (Sectigo)",
		sans: ["office.acme-retail.it"],
		issuer: "Sectigo RSA Domain Validation Secure Server CA",
		notBefore: ago(356),
		notAfter: inDays(9),
		domains: 1,
		createdAt: ago(300),
	},
	{
		id: "crt_nordwind_ev",
		name: "Nordwind wildcard 2027",
		sans: ["*.nordwind.de", "nordwind.de"],
		issuer: "DigiCert Global G2 TLS RSA SHA256 2020 CA1",
		notBefore: ago(20),
		notAfter: inDays(345),
		domains: 0,
		createdAt: ago(18),
	},
];

const managed: ManagedCertificate[] = [
	{
		names: ["*.acme-retail.it"],
		issuer: "E6",
		notBefore: ago(29),
		notAfter: inDays(61),
	},
	{
		names: ["studiorossi.it"],
		issuer: "R11",
		notBefore: ago(56),
		notAfter: inDays(34),
	},
	{
		names: ["status.logical.it"],
		issuer: "E5",
		notBefore: ago(78),
		notAfter: inDays(12),
	},
	{
		names: ["logical.it"],
		issuer: "E6",
		notBefore: ago(13),
		notAfter: inDays(77),
	},
	{
		names: ["www.logical.it"],
		issuer: "E6",
		notBefore: ago(13),
		notAfter: inDays(77),
	},
	{
		names: ["*.srv1.logical.it"],
		issuer: "E5",
		notBefore: ago(40),
		notAfter: inDays(50),
	},
];

const channels: Channel[] = [
	{
		id: "nch_ops",
		kind: "slack",
		name: "#ops-alerts",
		rules: 2,
		delivery: {
			lastSuccessAt: ago(0.04),
			lastFailureAt: null,
			lastError: null,
			consecutiveFailures: 0,
		},
		createdAt: ago(90),
	},
	{
		id: "nch_oncall",
		kind: "email",
		name: "On-call inbox",
		rules: 1,
		delivery: {
			lastSuccessAt: ago(3),
			lastFailureAt: ago(0.2),
			lastError: "smtp send: Invalid login: 535 5.7.8 Authentication failed",
			consecutiveFailures: 3,
		},
		createdAt: ago(60),
	},
	{
		id: "nch_hook",
		kind: "webhook",
		name: "Acme status relay",
		rules: 1,
		delivery: null,
		createdAt: ago(4),
	},
];

const rules: Rule[] = [
	{
		id: "nrl_1",
		events: ["deployment.failed", "node.down", "backup.failed"],
		scope: {},
		channelId: "nch_ops",
		enabled: true,
		createdAt: ago(90),
	},
	{
		id: "nrl_2",
		events: ["certificate.expiring", "certificate.failed", "domain.error"],
		scope: {},
		channelId: "nch_ops",
		enabled: true,
		createdAt: ago(80),
	},
	{
		id: "nrl_3",
		events: ["node.down", "deployment.failed"],
		scope: { projectId: "prj_storefront" },
		channelId: "nch_oncall",
		enabled: true,
		createdAt: ago(60),
	},
	{
		id: "nrl_4",
		events: ["deployment.succeeded", "deployment.failed"],
		scope: {
			projectId: "prj_storefront",
			serviceId: "svc_storefront_production_web",
		},
		channelId: "nch_hook",
		enabled: false,
		createdAt: ago(4),
	},
];

const issuer: { directory: AcmeDirectory } = { directory: "letsencrypt" };

const zoneFor = (hostname: string) => {
	let best: { provider: DnsProvider; zone: DnsZone } | null = null;
	for (const provider of providers)
		for (const zone of provider.zones)
			if (
				(hostname === zone.name || hostname.endsWith(`.${zone.name}`)) &&
				(!best || zone.name.length > best.zone.name.length)
			)
				best = { provider, zone };
	return best;
};

const fail = (message: string) =>
	Promise.reject(new ApiError(400, message, "bad_request"));

const rec = (
	name: string,
	type: DnsRecordSet["type"],
	values: string[],
	over: Partial<DnsRecordSet> = {},
): DnsRecordSet => ({
	id: rid("rec"),
	name,
	type,
	ttl: 1,
	values,
	domain: null,
	...over,
});

/** Record sets per zone id, seeded for the zones above. */
const zoneRecords = new Map<string, DnsRecordSet[]>([
	[
		"z_logical",
		[
			rec("logical.it", "A", [IP], { proxied: true }),
			rec("www.logical.it", "CNAME", ["logical.it"], { proxied: true }),
			rec("app.logical.it", "A", [IP], {
				proxied: false,
				domain: { id: "dom_app", hostname: "app.logical.it" },
			}),
			rec("api.logical.it", "A", [IP], {
				proxied: true,
				domain: { id: "dom_api", hostname: "api.logical.it" },
			}),
			rec("logical.it", "MX", ["10 mx1.improvmx.com"], { proxied: undefined }),
			rec("logical.it", "MX", ["20 mx2.improvmx.com"], { proxied: undefined }),
			rec("logical.it", "TXT", ["v=spf1 include:spf.improvmx.com ~all"], {
				comment: "Mail forwarding",
			}),
			rec("_dmarc.logical.it", "TXT", ["v=DMARC1; p=quarantine"], {
				ttl: 3600,
			}),
			rec("logical.it", "CAA", ['0 issue "letsencrypt.org"'], { ttl: 3600 }),
			rec("_sip._tcp.logical.it", "SRV", ["10 5 5060 sip.logical.it"], {
				ttl: 300,
			}),
		],
	],
	[
		"z_nordwind",
		[
			rec(
				"nordwind.de",
				"NS",
				["hydrogen.ns.hetzner.com", "oxygen.ns.hetzner.com"],
				{
					ttl: 3600,
					readOnly: "Protected at Hetzner, unprotect it in the Hetzner Console",
				},
			),
			rec("nordwind.de", "A", [IP], { ttl: 300 }),
			rec("shop.nordwind.de", "AAAA", ["2a01:4f8:c0c:1234::1"], { ttl: 300 }),
			rec(
				"nordwind.de",
				"MX",
				["10 mail.nordwind.de", "20 backup.nordwind.de"],
				{
					ttl: 3600,
				},
			),
		],
	],
]);

/** Each hostname resolves on Cloudflare first, then on Google a few polls later. */
const polls = new Map<string, number>();

export const networkingMock: NetworkingApi = {
	schemas: () => delay(schemas as never, 60),
	dns: {
		list: () => delay(providers),
		test: (kind, credentials) => {
			const token = Object.values(credentials).find(
				(v) => typeof v === "string",
			);
			if (typeof token !== "string" || token.length < 8)
				return delay(null, 900).then(() =>
					fail(`${kind} verify: HTTP 403: Invalid API Token`),
				);
			return delay(
				{
					zones: [
						{ id: "z_logical", name: "logical.it" },
						{ id: "z_acme", name: "acme-retail.it" },
						{ id: "z_rossi", name: "studiorossi.it" },
						{ id: "z_lab", name: "logical-labs.dev" },
					],
				},
				900,
			);
		},
		create: (input) => {
			const p: DnsProvider = {
				id: rid("dns"),
				kind: input.kind,
				name: input.name,
				zones: input.zones,
				domains: 0,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			providers.push(p);
			return delay(p);
		},
		update: (id, patch) => {
			const p = providers.find((x) => x.id === id);
			if (!p) return fail("dns provider not found");
			Object.assign(
				p,
				patch.name ? { name: patch.name } : {},
				patch.zones ? { zones: patch.zones } : {},
			);
			return delay(p);
		},
		remove: (id) => {
			const p = providers.find((x) => x.id === id);
			if (p?.domains)
				return Promise.reject(
					new ApiError(
						409,
						`${p.domains} domains still use this provider`,
						"conflict",
					),
				);
			providers.splice(
				providers.findIndex((x) => x.id === id),
				1,
			);
			return delay(undefined);
		},
		zones: (id) =>
			delay({ zones: providers.find((p) => p.id === id)?.zones ?? [] }),
		records: (id, zoneId) => {
			const p = providers.find((x) => x.id === id);
			const zone = p?.zones.find((z) => z.id === zoneId);
			if (!p || !zone)
				return Promise.reject(new ApiError(404, "zone not found", "not_found"));
			return delay({
				provider: { id: p.id, name: p.name, kind: p.kind },
				zone,
				records: zoneRecords.get(zoneId) ?? [],
			});
		},
		createRecord: (_id, zoneId, body) => {
			const list = zoneRecords.get(zoneId) ?? [];
			const r = rec(body.name, body.type, body.values, {
				ttl: body.ttl,
				proxied: body.proxied,
				comment: body.comment || undefined,
			});
			zoneRecords.set(zoneId, [...list, r]);
			return delay(r);
		},
		updateRecord: (_id, zoneId, recordId, body) => {
			const list = zoneRecords.get(zoneId) ?? [];
			const r = list.find((x) => x.id === recordId);
			if (!r) return fail("record not found");
			Object.assign(r, {
				name: body.name,
				values: body.values,
				ttl: body.ttl,
				proxied: body.proxied,
				comment: body.comment || undefined,
			});
			return delay(r);
		},
		removeRecord: (_id, zoneId, recordId) => {
			zoneRecords.set(
				zoneId,
				(zoneRecords.get(zoneId) ?? []).filter((x) => x.id !== recordId),
			);
			return delay(undefined);
		},
		match: (_serviceId, hostname) => {
			const m = zoneFor(hostname);
			return delay(
				{
					publicIp: IP,
					match: m
						? {
								providerId: m.provider.id,
								providerName: m.provider.name,
								kind: m.provider.kind,
								zone: m.zone,
								existing: [],
							}
						: null,
				},
				500,
			);
		},
		upsertRecord: (_serviceId, input) =>
			delay(
				{
					id: rid("rec"),
					zoneId: zoneFor(input.hostname)?.zone.id ?? "z",
					name: input.hostname,
					type: input.type,
					content: input.content,
					ttl: 1,
					proxied: input.proxied,
				},
				700,
			),
		propagation: (_serviceId, input) => {
			const n = (polls.get(input.hostname) ?? 0) + 1;
			polls.set(input.hostname, n);
			return delay(
				{
					ok: n >= 3,
					resolvers: [
						{ name: "cloudflare", ok: n >= 1 },
						{ name: "google", ok: n >= 3 },
					],
				},
				400,
			);
		},
		setupCheck: (input) =>
			delay(
				{
					zone: {
						id: "z_logical",
						name: input.base.split(".").slice(-2).join("."),
					},
				},
				800,
			),
	},
	domains: {
		list: () => delay(domains),
		create: (serviceId, body) => {
			const owner = domains.find((d) => d.service.id === serviceId);
			const d = row(
				body.hostname,
				owner ?? svc("x", "service", "x", "Project"),
				{
					...body,
					pathPrefix: body.pathPrefix ?? null,
					dnsProviderId: body.dnsProviderId ?? null,
					dnsRecordId: body.dnsRecordId ?? null,
					tunnel: body.tunnel ?? false,
					customCertificateId: body.customCertificateId ?? null,
					redirectTo: body.redirectTo ?? null,
					tls: !body.https
						? "none"
						: body.cert === "custom"
							? "custom"
							: body.dnsProviderId
								? "dns-01"
								: "http-01",
					status: "pending",
					createdAt: new Date().toISOString(),
				},
			);
			domains.push(d);
			return delay({ id: d.id });
		},
		update: (id) => delay({ id }),
		remove: (id) => {
			domains.splice(
				domains.findIndex((d) => d.id === id),
				1,
			);
			return delay(undefined);
		},
	},
	certificates: {
		list: () => delay({ custom, managed }),
		inspect: (certPem) =>
			certPem.includes("BEGIN CERTIFICATE")
				? delay(
						{
							sans: ["shop.acme-retail.it", "www.shop.acme-retail.it"],
							issuer: "Sectigo RSA Domain Validation Secure Server CA",
							notBefore: ago(2),
							notAfter: inDays(395),
						},
						700,
					)
				: delay(null, 500).then(() =>
						fail(
							"The certificate must be PEM, starting with -----BEGIN CERTIFICATE-----",
						),
					),
		create: (input) => {
			const c: CustomCertificate = {
				id: rid("crt"),
				name: input.name,
				sans: ["shop.acme-retail.it", "www.shop.acme-retail.it"],
				issuer: "Sectigo RSA Domain Validation Secure Server CA",
				notBefore: ago(2),
				notAfter: inDays(395),
				domains: 0,
				createdAt: new Date().toISOString(),
			};
			custom.push(c);
			return delay(c);
		},
		originTest: (domainId) => {
			const d = domains.find((x) => x.id === domainId);
			const host = d?.hostname ?? "";
			for (const p of providers.filter((x) => x.kind === "cloudflare")) {
				const zone = p.zones.find(
					(z) => host === z.name || host.endsWith(`.${z.name}`),
				);
				if (zone)
					return delay(
						{
							hostname: host,
							provider: { id: p.id, name: p.name },
							zone,
							permission: "Zone > SSL and Certificates > Edit",
						},
						800,
					);
			}
			return delay(null, 500).then(() =>
				fail(
					`No Cloudflare DNS provider manages a zone for ${host}. Connect one under Integrations, DNS first.`,
				),
			);
		},
		originIssue: (domainId, input) => {
			const d = domains.find((x) => x.id === domainId);
			const host = d?.hostname ?? "";
			const c: CustomCertificate = {
				id: rid("crt"),
				name: `${host} (Cloudflare Origin)`,
				sans: [host],
				issuer: "CloudFlare Origin Certificate Authority",
				notBefore: new Date().toISOString(),
				notAfter: inDays(input.validityDays),
				domains: 1,
				createdAt: new Date().toISOString(),
			};
			custom.push(c);
			if (d)
				Object.assign(d, {
					https: true,
					cert: "custom",
					tls: "custom",
					customCertificateId: c.id,
					status: "pending",
					certificate: {
						source: "custom",
						name: c.name,
						issuer: c.issuer,
						notAfter: c.notAfter,
					},
				});
			return delay(c, 1200);
		},
		remove: (id) => {
			const c = custom.find((x) => x.id === id);
			if (c?.domains)
				return Promise.reject(
					new ApiError(409, "1 domain still uses this certificate", "conflict"),
				);
			custom.splice(
				custom.findIndex((x) => x.id === id),
				1,
			);
			return delay(undefined);
		},
		issuer: () => delay({ directory: issuer.directory }),
		setIssuer: (directory) => {
			issuer.directory = directory;
			return delay({ directory });
		},
	},
	notifications: {
		channels: () => delay(channels),
		testConfig: () => delay(undefined, 1100),
		createChannel: (input) => {
			const c: Channel = {
				id: rid("nch"),
				kind: input.kind,
				name: input.name,
				rules: 0,
				delivery: null,
				createdAt: new Date().toISOString(),
			};
			channels.push(c);
			return delay(c);
		},
		testChannel: () => delay(undefined, 900),
		removeChannel: (id) => {
			channels.splice(
				channels.findIndex((c) => c.id === id),
				1,
			);
			for (let i = rules.length - 1; i >= 0; i--)
				if (rules[i]?.channelId === id) rules.splice(i, 1);
			return delay(undefined);
		},
		rules: () => delay(rules),
		createRule: (input) => {
			const r: Rule = {
				id: rid("nrl"),
				...input,
				enabled: input.enabled ?? true,
				createdAt: new Date().toISOString(),
			};
			rules.push(r);
			const ch = channels.find((c) => c.id === input.channelId);
			if (ch) ch.rules++;
			return delay(r);
		},
		updateRule: (id, input) => {
			const r = rules.find((x) => x.id === id);
			if (!r) return fail("notification rule not found");
			Object.assign(r, input);
			return delay(r);
		},
		removeRule: (id) => {
			const r = rules.find((x) => x.id === id);
			rules.splice(
				rules.findIndex((x) => x.id === id),
				1,
			);
			const ch = channels.find((c) => c.id === r?.channelId);
			if (ch) ch.rules--;
			return delay(undefined);
		},
	},
};
