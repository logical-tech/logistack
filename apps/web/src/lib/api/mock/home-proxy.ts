import {
	type HomeProxy,
	HomeProxyEnableInput,
	type HomeProxyRoute,
	HomeProxyRouteInput,
	HomeProxyRouteUpdateInput,
	HomeProxyTestInput,
	HomeProxyUpdateInput,
	parseHomeProxyUpstream,
} from "@logistack/contracts";
import type { z } from "zod";
import { ApiError } from "../adapter";
import type { HomeProxyApi } from "../home-proxy";
import { mockHomeDns } from "./home-dns";

/*
 * On, at home.example.com with a Let's Encrypt wildcard through Cloudflare, three devices
 * routed. Choosing the internal CA hands out a root a few seconds later, as the worker does.
 * The connection test fails for hosts ending in .99 and for HTTPS upstreams on private
 * addresses unless certificate errors are ignored, so both outcomes can be seen.
 */

const delay = <T>(v: T, ms = 180 + Math.random() * 220) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

/** Zones the mock's DNS providers hold, for the `acme` check. */
const PROVIDER_ZONES: [zone: string, provider: string][] = [
	["example.com", "Cloudflare"],
	["logical.it", "Cloudflare · Logical"],
	["acme-retail.it", "Cloudflare · Logical"],
	["nordwind.de", "Hetzner · Nordwind"],
];

const CA_ROOT = `-----BEGIN CERTIFICATE-----
MIIBozCCAUqgAwIBAgIRAKMockLogiStackLocalCARootMAoGCCqGSM49BAMCMDAx
LjAsBgNVBAMTJUNhZGR5IExvY2FsIEF1dGhvcml0eSAtIDIwMjYgRUNDIFJvb3Qw
HhcNMjYxMTE2MDAwMDAwWhcNMzYwOTI1MDAwMDAwWjAwMS4wLAYDVQQDEyVDYWRk
eSBMb2NhbCBBdXRob3JpdHkgLSAyMDI2IEVDQyBSb290MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEmockmockmockmockmockmockmockmockmockmockmockmock
-----END CERTIFICATE-----
`;

type State = {
	zone: string;
	tls: "acme" | "internal";
	/** When the internal root becomes readable; 0 when it already is or tls is acme. */
	caAt: number;
	updatedAt: string;
	routes: Omit<HomeProxyRoute, "hostname">[];
};

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

let s: State | null = {
	zone: "home.example.com",
	tls: "acme",
	caAt: 0,
	updatedAt: ago(60 * 24 * 3),
	routes: [
		{
			id: "hpr_ha",
			name: "ha",
			upstream: "http://192.168.1.20:8123",
			insecure: false,
			createdAt: ago(60 * 24 * 3),
		},
		{
			id: "hpr_nas",
			name: "nas",
			upstream: "https://192.168.1.10:5001",
			insecure: true,
			createdAt: ago(60 * 24 * 2),
		},
		{
			id: "hpr_router",
			name: "router",
			upstream: "http://192.168.1.1:80",
			insecure: false,
			createdAt: ago(60 * 5),
		},
	],
};

let seq = 0;

const providerFor = (zone: string) =>
	PROVIDER_ZONES.find(([z]) => zone === z || zone.endsWith(`.${z}`))?.[1] ??
	null;

function on(): State {
	if (!s)
		throw new ApiError(
			409,
			"the local proxy is off; enable it first",
			"conflict",
		);
	return s;
}

/** zod failures as the API reports them. */
function parse<S extends z.ZodType>(schema: S, v: unknown): z.output<S> {
	const r = schema.safeParse(v);
	if (!r.success)
		throw new ApiError(
			422,
			r.error.issues[0]?.message ?? "invalid input",
			"validation_failed",
		);
	return r.data;
}

function checkSettings(zone: string, tls: "acme" | "internal") {
	if (tls === "acme" && !providerFor(zone))
		throw new ApiError(
			422,
			`no connected DNS provider holds ${zone}; connect one, or use the internal certificate authority`,
			"validation_failed",
		);
}

/** Like the server: the home DNS (when on) writes the records, whether or not the proxy is on. */
async function view(): Promise<HomeProxy> {
	const dns = await mockHomeDns.get();
	const records = {
		lanAddress: dns.enabled ? dns.lanAddress : null,
		automaticRecords: dns.enabled,
	};
	if (!s)
		return {
			enabled: false,
			zone: null,
			tls: null,
			dnsProvider: null,
			...records,
			caRootPem: null,
			statusMessage: null,
			updatedAt: null,
		};
	const caReady = s.tls === "internal" && Date.now() >= s.caAt;
	return {
		enabled: true,
		zone: s.zone,
		tls: s.tls,
		dnsProvider: s.tls === "acme" ? providerFor(s.zone) : null,
		...records,
		caRootPem: caReady ? CA_ROOT : null,
		statusMessage:
			s.tls === "internal" && !caReady
				? "Creating the internal certificate authority"
				: null,
		updatedAt: s.updatedAt,
	};
}

const routeView = (st: State, r: State["routes"][number]): HomeProxyRoute => ({
	...r,
	hostname: `${r.name}.${st.zone}`,
});

function unique(st: State, name: string, except?: string) {
	if (st.routes.some((r) => r.name === name && r.id !== except))
		throw new ApiError(409, `a route named ${name} already exists`, "conflict");
}

export const mockHomeProxy: HomeProxyApi = {
	get: async () => delay(await view()),
	enable: async (input) => {
		if (s) throw new ApiError(409, "the local proxy is already on", "conflict");
		const v = parse(HomeProxyEnableInput, input);
		checkSettings(v.zone, v.tls);
		s = {
			zone: v.zone,
			tls: v.tls,
			caAt: v.tls === "internal" ? Date.now() + 4000 : 0,
			updatedAt: new Date().toISOString(),
			routes: [],
		};
		return delay(await view(), 500);
	},
	update: async (input) => {
		const st = on();
		const v = parse(HomeProxyUpdateInput, input);
		const next = { zone: v.zone ?? st.zone, tls: v.tls ?? st.tls };
		checkSettings(next.zone, next.tls);
		if (next.tls !== st.tls)
			st.caAt = next.tls === "internal" ? Date.now() + 4000 : 0;
		Object.assign(st, next, { updatedAt: new Date().toISOString() });
		return delay(await view(), 400);
	},
	disable: () => {
		on();
		s = null;
		return delay(undefined, 500);
	},
	test: (upstream, insecure) => {
		on();
		const v = parse(HomeProxyTestInput, { upstream, insecure });
		const u = parseHomeProxyUpstream(v.upstream);
		const ms = 4 + Math.round(Math.random() * 40);
		const fail = (error: string, after = ms) =>
			delay({ ok: false, status: null, error, ms: after }, 600);
		if (!u) return fail("invalid upstream");
		if (u.host.endsWith(".99")) return fail("The operation timed out.", 5000);
		if (u.port === 9)
			return fail(`Unable to connect. Is the computer able to access the url?`);
		if (u.scheme === "https" && !v.insecure)
			return fail("self signed certificate");
		return delay(
			{ ok: true, status: u.port === 8123 ? 200 : 302, error: null, ms },
			500,
		);
	},
	routes: () => delay(s ? s.routes.map((r) => routeView(on(), r)) : []),
	addRoute: (input) => {
		const st = on();
		const v = parse(HomeProxyRouteInput, input);
		unique(st, v.name);
		const r = {
			id: `hpr_${++seq}`,
			...v,
			createdAt: new Date().toISOString(),
		};
		st.routes = [...st.routes, r].sort((a, b) => a.name.localeCompare(b.name));
		return delay(routeView(st, r));
	},
	updateRoute: (id, input) => {
		const st = on();
		const v = parse(HomeProxyRouteUpdateInput, input);
		const before = st.routes.find((r) => r.id === id);
		if (!before) throw new ApiError(404, "route not found", "not_found");
		if (v.name) unique(st, v.name, id);
		const r = { ...before, ...v };
		st.routes = st.routes
			.map((x) => (x.id === id ? r : x))
			.sort((a, b) => a.name.localeCompare(b.name));
		return delay(routeView(st, r));
	},
	deleteRoute: (id) => {
		const st = on();
		st.routes = st.routes.filter((r) => r.id !== id);
		return delay(undefined);
	},
};
