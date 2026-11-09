import type { DatabaseEngine } from "@logistack/contracts";
import {
	type Labels,
	managedLabels,
	type ServiceSpec,
} from "@logistack/docker";

// Public access and port forwards to a database go through a gateway service of ours
// (docs/plans/database-ops.md): it filters the source address, refuses openings that are not a
// TLS request, and pipes the bytes to the database, which terminates TLS itself.

/** The port each engine listens on inside its container. */
export const DATABASE_PORTS: Record<DatabaseEngine, number> = {
	postgres: 5432,
	mysql: 3306,
	mariadb: 3306,
	mongo: 27017,
	redis: 6379,
	libsql: 8080,
};

/** Redis cannot serve TLS and plain on one port, so TLS gets its own. */
export const REDIS_TLS_PORT = 6380;

/** Engines that can be exposed: libSQL speaks HTTP and has no TLS of its own. */
export const EXPOSABLE_ENGINES = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
] as const satisfies DatabaseEngine[];

export const isExposable = (engine: DatabaseEngine) =>
	(EXPOSABLE_ENGINES as readonly DatabaseEngine[]).includes(engine);

/** Port forwards take a port from this range; public access picks its own. */
export const FORWARD_PORT_RANGE = { from: 15000, to: 15999 } as const;

/**
 * How the gateway judges a connection's opening bytes. `plain` checks nothing (a forward to a
 * database without a certificate); the others accept only a TLS request.
 */
export const GATEWAY_MODES = ["postgres", "mysql", "tls", "plain"] as const;
export type GatewayMode = (typeof GATEWAY_MODES)[number];

export function gatewayMode(
	engine: DatabaseEngine,
	tlsRequired: boolean,
): GatewayMode {
	if (!tlsRequired) return "plain";
	if (engine === "postgres") return "postgres";
	if (engine === "mysql" || engine === "mariadb") return "mysql";
	return "tls";
}

/** Where the gateway dials inside the database's container. */
export const gatewayUpstreamPort = (
	engine: DatabaseEngine,
	tlsRequired: boolean,
) =>
	engine === "redis" && tlsRequired ? REDIS_TLS_PORT : DATABASE_PORTS[engine];

const TLS_HANDSHAKE = 0x16;
const PG_SSL_REQUEST = [0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f];
const MYSQL_CLIENT_SSL = 0x0800;

export type Opening = "accept" | "refuse" | "more";

/**
 * Pure: whether the first bytes a client sent (after the server greeting, on MySQL) ask for TLS.
 * `more` means too few bytes to tell yet.
 */
export function judgeOpening(mode: GatewayMode, bytes: Uint8Array): Opening {
	if (mode === "plain") return "accept";
	if (!bytes.length) return "more";
	if (mode === "tls") return bytes[0] === TLS_HANDSHAKE ? "accept" : "refuse";
	if (mode === "postgres") {
		// Postgres 17 clients with sslnegotiation=direct open with a ClientHello.
		if (bytes[0] === TLS_HANDSHAKE) return "accept";
		for (let i = 0; i < PG_SSL_REQUEST.length; i++) {
			if (i >= bytes.length) return "more";
			if (bytes[i] !== PG_SSL_REQUEST[i]) return "refuse";
		}
		return "accept";
	}
	// MySQL: a 4-byte header (3-byte length, sequence 1), then the capability flags. The
	// SSLRequest is a 32-byte payload with CLIENT_SSL set; a full handshake response is longer.
	if (bytes.length < 8) return "more";
	const length =
		(bytes[0] as number) |
		((bytes[1] as number) << 8) |
		((bytes[2] as number) << 16);
	const caps = (bytes[4] as number) | ((bytes[5] as number) << 8);
	return length === 32 && bytes[3] === 1 && (caps & MYSQL_CLIENT_SSL) !== 0
		? "accept"
		: "refuse";
}

/** The environment a gateway reads at start (`apps/worker/src/db-gateway.ts`). */
export type GatewayEnv = {
	LS_GW_LISTEN: string;
	LS_GW_UPSTREAM: string;
	LS_GW_MODE: GatewayMode;
	/** Comma-separated addresses and CIDR ranges. */
	LS_GW_ALLOW: string;
	/** ISO time the gateway closes everything; empty: never. */
	LS_GW_EXPIRES_AT: string;
};

export type DbGatewayInput = {
	access: {
		id: string;
		organizationId: string;
		port: number;
		allowedCidrs: string[];
		expiresAt: Date | null;
	};
	engine: DatabaseEngine;
	tlsRequired: boolean;
	/** The database's Swarm service name, resolvable on `network`. */
	upstreamHost: string;
	/** The org's database network id. */
	network: string;
	/** Swarm node id the database is pinned to; the host-mode port binds there. */
	nodeId: string;
	image: string;
	scope?: { namePrefix: string; labels: Labels };
};

/**
 * The organization's database network (docs/plans/database-ops.md §5), named from a hash of its
 * id because better-auth ids are mixed case and of no fixed shape.
 */
export const orgDbNetworkName = (organizationId: string, prefix = "") =>
	orgNetworkName("db", organizationId, prefix);

/**
 * One organization's network of a kind: `ingress` (its public services and the proxy), `storage`
 * and `game` (its services and the api). Tenants never share one, so a container of one
 * organization cannot dial another's services around the proxy's access rules.
 */
export const orgNetworkName = (
	kind: "db" | "ingress" | "storage" | "game",
	organizationId: string,
	prefix = "",
) =>
	`${prefix}ls-${kind}-${new Bun.CryptoHasher("sha256").update(organizationId).digest("hex").slice(0, 12)}`;

/** Docker name of an access row's gateway: `ls-gw-<id body>`. */
export const gatewayName = (accessId: string, prefix = "") =>
	`${prefix}ls-gw-${accessId.slice(accessId.indexOf("_") + 1)}`;

/** Pure: the gateway's Swarm service. Host mode keeps the client's address visible to it. */
export function compileDbGateway(i: DbGatewayInput): ServiceSpec {
	const labels: Labels = {
		...managedLabels({
			resource: i.access.id,
			kind: "gateway",
			org: i.access.organizationId,
		}),
		...i.scope?.labels,
	};
	const env: GatewayEnv = {
		LS_GW_LISTEN: String(i.access.port),
		LS_GW_UPSTREAM: `${i.upstreamHost}:${gatewayUpstreamPort(i.engine, i.tlsRequired)}`,
		LS_GW_MODE: gatewayMode(i.engine, i.tlsRequired),
		LS_GW_ALLOW: i.access.allowedCidrs.join(","),
		LS_GW_EXPIRES_AT: i.access.expiresAt?.toISOString() ?? "",
	};
	return {
		Name: gatewayName(i.access.id, i.scope?.namePrefix),
		Labels: labels,
		TaskTemplate: {
			ContainerSpec: {
				Image: i.image,
				Labels: labels,
				Env: [
					"ROLE=dbgateway",
					...Object.entries(env).map(([k, v]) => `${k}=${v}`),
				],
				StopGracePeriod: 5e9,
				// The image's own check probes the api's HTTP port, which a gateway does not serve.
				Healthcheck: { Test: ["NONE"] },
			},
			// An expired forward exits 0 and must stay down.
			RestartPolicy: { Condition: "on-failure", Delay: 5e9, MaxAttempts: 0 },
			Placement: { Constraints: [`node.id==${i.nodeId}`] },
			Networks: [{ Target: i.network }],
		},
		Mode: { Replicated: { Replicas: 1 } },
		// Host ports cannot be held by two tasks at once.
		UpdateConfig: { Parallelism: 1, Order: "stop-first" },
		EndpointSpec: {
			Mode: "vip",
			Ports: [
				{
					Protocol: "tcp",
					TargetPort: i.access.port,
					PublishedPort: i.access.port,
					PublishMode: "host",
				},
			],
		},
	};
}

/**
 * Pure: the URI a client uses through a gateway, with the engine's TLS parameter. `password`
 * absent leaves a placeholder for the UI to fill.
 */
export function connectionUri(i: {
	engine: DatabaseEngine;
	host: string;
	port: number;
	user: string;
	password?: string;
	database: string;
	/** `verify`: the certificate names `host`; `require`: encrypted, name not checked (a forward to a node address). */
	tls: false | "require" | "verify";
}): string {
	const auth = (user: string) => {
		const pw = encodeURIComponent(i.password ?? "PASSWORD");
		return user ? `${encodeURIComponent(user)}:${pw}@` : `:${pw}@`;
	};
	const hostPort = `${i.host}:${i.port}`;
	const db = encodeURIComponent(i.database);
	switch (i.engine) {
		case "postgres":
			return `postgres://${auth(i.user)}${hostPort}/${db}${i.tls ? `?sslmode=${i.tls === "verify" ? "verify-full" : "require"}` : ""}`;
		case "mysql":
		case "mariadb":
			return `mysql://${auth(i.user)}${hostPort}/${db}${i.tls ? `?ssl-mode=${i.tls === "verify" ? "VERIFY_IDENTITY" : "REQUIRED"}` : ""}`;
		case "mongo":
			return `mongodb://${auth(i.user)}${hostPort}/${db}?authSource=admin${i.tls ? `&tls=true${i.tls === "require" ? "&tlsAllowInvalidHostnames=true" : ""}` : ""}`;
		case "redis":
			return `${i.tls ? "rediss" : "redis"}://${auth("")}${hostPort}/0`;
		case "libsql":
			return `libsql://${hostPort}`;
	}
}
