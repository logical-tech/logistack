import type { Resource } from "@logistack/core";
import type { Db } from "@logistack/db";
import type { NodeRunner } from "@logistack/worker/node-runner";
import type { Actor } from "./actor.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Bus } from "./events.ts";

export type Deps = {
	config: Config;
	db: Db;
	auth: Auth;
	masterKey: CryptoKey;
	bus: Bus;
	/** Jobs, execs and log follows on any node, whichever replica holds its agent socket. */
	nodes: NodeRunner;
	/** How the api dials a storage service's port; default its Swarm name on ls-storage. */
	storageEndpoint?: (serviceId: string, port: number) => string;
	/** How the api dials a database service's port; default its Swarm name on ls-db. */
	databaseEndpoint?: (
		serviceId: string,
		port: number,
	) => { host: string; port: number };
	/** How the api dials a game server's container port; default its Swarm name on ls-game. */
	gameEndpoint?: (
		serviceId: string,
		port: number,
	) => { host: string; port: number };
	/** Statement timeout of explorer queries; default 30 s. Tests shorten it. */
	databaseStatementTimeoutMs?: number;
};

export type Env = {
	/** The Bun server when served by Bun.serve; absent under `app.request()` in tests. */
	Bindings: {
		requestIP?: (req: Request) => { address: string } | null;
		/** Per-request idle timeout in seconds; 0 disables it (long AI streams). */
		timeout?: (req: Request, seconds: number) => void;
	};
	Variables: {
		deps: Deps;
		requestId: string;
		actor: Actor | undefined;
		/** Set by `requirePermission`; the audit row's default resource. */
		resource: Resource | undefined;
		/** Set by a mutation handler when it creates or targets a row the resource does not name. */
		auditResourceId: string | undefined;
		/** Overrides the default diff (`{ input: <request body> }`). Redacted before insert. */
		auditDiff: unknown;
	};
};
