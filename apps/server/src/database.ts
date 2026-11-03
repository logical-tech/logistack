import type { DatabaseEngine } from "@logistack/contracts";
import { decrypt, dockerName } from "@logistack/core";
import { envVar, service } from "@logistack/db";
import { type DatabaseClient, databaseClient } from "@logistack/providers";
import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import type { Deps, Env } from "./env.ts";
import { Failure, notFound } from "./errors.ts";

const ports: Record<DatabaseEngine, number> = {
	postgres: 5432,
	mysql: 3306,
	mariadb: 3306,
	mongo: 27017,
	redis: 6379,
};

/**
 * Where the api dials a database: its Swarm service name, which resolves on `ls-db` (the api
 * joins it in the stack, databases join it when they deploy). Tests override it.
 */
export const defaultDatabaseEndpoint = (serviceId: string, port: number) => ({
	host: dockerName("svc", serviceId),
	port,
});

export type DatabaseService = {
	id: string;
	slug: string;
	engine: DatabaseEngine;
	client: DatabaseClient;
};

const ENV_KEYS = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"];

async function credentials(deps: Deps, serviceId: string) {
	const rows = await deps.db
		.select({ key: envVar.key, value: envVar.valueEncrypted })
		.from(envVar)
		.where(
			and(
				eq(envVar.scope, "service"),
				eq(envVar.scopeId, serviceId),
				inArray(envVar.key, ENV_KEYS),
			),
		);
	return Object.fromEntries(
		await Promise.all(
			rows.map(async (r) => [r.key, await decrypt(deps.masterKey, r.value)]),
		),
	) as Record<string, string>;
}

// One pool per service, replaced when the credentials change. Pools close idle connections themselves.
const clients = new Map<string, { key: string; client: DatabaseClient }>();

/** The database service behind `serviceId` with a pooled client logged in as its superuser. */
export async function openDatabase(
	c: Context<Env>,
	serviceId: string,
): Promise<DatabaseService> {
	const deps = c.var.deps;
	const [row] = await deps.db
		.select({ slug: service.slug, spec: service.spec })
		.from(service)
		.where(eq(service.id, serviceId));
	if (!row) throw notFound("service");
	if (row.spec.kind !== "database")
		throw new Failure("bad_request", "not a database service");
	const engine = row.spec.engine;
	if (engine !== "postgres")
		throw new Failure(
			"bad_request",
			`the explorer does not support ${engine} yet`,
		);
	const env = await credentials(deps, serviceId);
	const password = env.POSTGRES_PASSWORD;
	if (!password)
		throw new Failure(
			"conflict",
			"POSTGRES_PASSWORD is missing from the service env",
		);
	const user = env.POSTGRES_USER || "postgres";
	const conn = {
		engine,
		...(deps.databaseEndpoint ?? defaultDatabaseEndpoint)(
			serviceId,
			ports[engine],
		),
		user,
		password,
		database: env.POSTGRES_DB || user,
		statementTimeoutMs: deps.databaseStatementTimeoutMs,
	};
	const key = Bun.hash(JSON.stringify(conn)).toString(16);
	let cached = clients.get(serviceId);
	if (cached?.key !== key) {
		cached?.client.close().catch(() => {});
		cached = { key, client: databaseClient(conn) };
		clients.set(serviceId, cached);
	}
	return { id: serviceId, slug: row.slug, engine, client: cached.client };
}

// shortcut: in memory, so a cancel must reach the api replica running the query; share it (Redis) when the api scales out.
const runs = new Map<
	string,
	{ serviceId: string; actorId: string; abort: AbortController }
>();

/** Runs a script under `runId` (when given) so its own actor can cancel it. */
export async function runQuery(
	db: DatabaseService,
	actorId: string,
	input: { sql: string; readOnly: boolean; runId?: string },
) {
	const abort = new AbortController();
	const { runId } = input;
	if (runId) {
		if (runs.has(runId)) throw new Failure("conflict", "run already started");
		runs.set(runId, { serviceId: db.id, actorId, abort });
	}
	try {
		return await db.client.query(input.sql, {
			readOnly: input.readOnly,
			signal: abort.signal,
		});
	} finally {
		if (runId) runs.delete(runId);
	}
}

/** Aborts a run of `actorId` on `serviceId`; false when there is none (finished, or not theirs). */
export function cancelRun(serviceId: string, actorId: string, runId: string) {
	const run = runs.get(runId);
	if (run?.serviceId !== serviceId || run.actorId !== actorId) return false;
	run.abort.abort();
	return true;
}
