import { describe, expect, test } from "bun:test";
import {
	compileDbGateway,
	connectionUri,
	gatewayMode,
	gatewayUpstreamPort,
	judgeOpening,
	orgDbNetworkName,
} from "../src/db-access.ts";
import {
	compareRowCounts,
	isLaterVersion,
	parseRowCounts,
	rowCountScript,
	upgradeDumpScript,
	upgradeRestoreScript,
} from "../src/db-scripts.ts";

const bytes = (...b: number[]) => new Uint8Array(b);
const PG_SSL = [0, 0, 0, 8, 4, 210, 22, 47];
/** A plain Postgres StartupMessage header: length 41, protocol 3.0. */
const PG_PLAIN = [0, 0, 0, 41, 0, 3, 0, 0];

describe("judgeOpening", () => {
	test("postgres accepts an SSLRequest or a direct ClientHello, refuses a startup", () => {
		expect(judgeOpening("postgres", bytes(...PG_SSL))).toBe("accept");
		expect(judgeOpening("postgres", bytes(0x16, 3, 1))).toBe("accept");
		expect(judgeOpening("postgres", bytes(...PG_PLAIN))).toBe("refuse");
		// GSSENCRequest is not TLS.
		expect(judgeOpening("postgres", bytes(0, 0, 0, 8, 4, 210, 22, 48))).toBe(
			"refuse",
		);
	});

	test("postgres waits for more bytes until it can tell", () => {
		expect(judgeOpening("postgres", bytes())).toBe("more");
		expect(judgeOpening("postgres", bytes(...PG_SSL.slice(0, 5)))).toBe("more");
		expect(judgeOpening("postgres", bytes(0, 0, 0, 41))).toBe("refuse");
	});

	test("mysql accepts only the 32-byte SSLRequest with CLIENT_SSL", () => {
		const header = (len: number, caps: number) =>
			bytes(len & 255, len >> 8, 0, 1, caps & 255, (caps >> 8) & 255, 0, 0);
		expect(judgeOpening("mysql", header(32, 0x0a8d))).toBe("accept");
		expect(judgeOpening("mysql", header(32, 0x0285))).toBe("refuse");
		// A full handshake response sent in plain.
		expect(judgeOpening("mysql", header(180, 0x0a8d))).toBe("refuse");
		expect(judgeOpening("mysql", bytes(32, 0, 0, 1))).toBe("more");
	});

	test("direct-TLS engines accept a ClientHello only; plain checks nothing", () => {
		expect(judgeOpening("tls", bytes(0x16, 3, 1))).toBe("accept");
		expect(
			judgeOpening("tls", new TextEncoder().encode("*1\r\n$4\r\nPING")),
		).toBe("refuse");
		expect(judgeOpening("plain", bytes())).toBe("accept");
	});

	test("modes and upstream ports follow the engine", () => {
		expect(gatewayMode("mariadb", true)).toBe("mysql");
		expect(gatewayMode("mongo", true)).toBe("tls");
		expect(gatewayMode("postgres", false)).toBe("plain");
		expect(gatewayUpstreamPort("redis", true)).toBe(6380);
		expect(gatewayUpstreamPort("redis", false)).toBe(6379);
	});
});

test("the gateway compiles to a host-mode service on the org network, pinned to the database's node", () => {
	expect(
		compileDbGateway({
			access: {
				id: "dba_gw0000000000000000000000",
				organizationId: "org_acme",
				port: 15001,
				allowedCidrs: ["203.0.113.7", "198.51.100.0/24"],
				expiresAt: new Date("2026-11-08T12:00:00Z"),
			},
			engine: "postgres",
			tlsRequired: true,
			upstreamHost: "ls-svc-db0000000000000000000000",
			network: "net-org-db",
			nodeId: "node-a",
			image: "ghcr.io/logical-tech/logistack:0.6.0",
		}),
	).toMatchSnapshot();
});

test("the org network name is derived from the id, stable and short", () => {
	expect(orgDbNetworkName("AbCdEf123")).toMatch(/^ls-db-[0-9a-f]{12}$/);
	expect(orgDbNetworkName("AbCdEf123")).toBe(orgDbNetworkName("AbCdEf123"));
	expect(orgDbNetworkName("AbCdEf123")).not.toBe(orgDbNetworkName("abcdef123"));
	expect(orgDbNetworkName("x", "ls-test-")).toStartWith("ls-test-ls-db-");
});

test("connection URIs carry each engine's TLS parameter", () => {
	const base = { host: "db.example.com", port: 5432, database: "app" };
	expect(
		connectionUri({ ...base, engine: "postgres", user: "app", tls: "verify" }),
	).toBe("postgres://app:PASSWORD@db.example.com:5432/app?sslmode=verify-full");
	expect(
		connectionUri({ ...base, engine: "mysql", user: "root", tls: "require" }),
	).toBe("mysql://root:PASSWORD@db.example.com:5432/app?ssl-mode=REQUIRED");
	expect(
		connectionUri({ ...base, engine: "mongo", user: "root", tls: "verify" }),
	).toBe(
		"mongodb://root:PASSWORD@db.example.com:5432/app?authSource=admin&tls=true",
	);
	expect(
		connectionUri({ ...base, engine: "redis", user: "", tls: "verify" }),
	).toBe("rediss://:PASSWORD@db.example.com:5432/0");
	expect(
		connectionUri({
			...base,
			engine: "postgres",
			user: "a@b",
			password: "p/w",
			tls: false,
		}),
	).toBe("postgres://a%40b:p%2Fw@db.example.com:5432/app");
});

describe("upgrades", () => {
	test("isLaterVersion compares the numbers a tag starts with", () => {
		expect(isLaterVersion("16", "17")).toBe(true);
		expect(isLaterVersion("16-alpine", "17-alpine")).toBe(true);
		expect(isLaterVersion("8.0", "8.4")).toBe(true);
		expect(isLaterVersion("10.11.6", "11.4")).toBe(true);
		expect(isLaterVersion("17", "17-alpine")).toBe(false);
		expect(isLaterVersion("17", "16")).toBe(false);
		expect(isLaterVersion("latest", "18")).toBe(false);
	});

	test("row counts parse and compare table by table", () => {
		const a = parseRowCounts(
			"shop.public.orders\t10000\nshop.public.users\t5\n",
		);
		expect(a).toEqual({ "shop.public.orders": 10000, "shop.public.users": 5 });
		expect(compareRowCounts(a, { ...a })).toEqual([]);
		expect(
			compareRowCounts(a, { "shop.public.orders": 9998, "shop.public.x": 1 }),
		).toEqual([
			"shop.public.orders: 10000 before, 9998 after",
			"shop.public.users: 5 before, missing after",
			"shop.public.x: missing before, 1 after",
		]);
	});

	test("postgres moves the whole cluster, roles included; scripts keep secrets off argv", () => {
		expect(upgradeDumpScript("postgres")).toContain("pg_dumpall");
		expect(upgradeRestoreScript("postgres")).toContain("psql");
		for (const e of ["postgres", "mysql", "mariadb", "mongo"] as const) {
			const s = rowCountScript(e);
			expect(s).not.toMatch(/--password[= ]|-p\$/);
			expect(s).toContain("sort");
		}
		expect(() => rowCountScript("redis")).toThrow();
	});
});
