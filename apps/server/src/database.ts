import type { DatabaseEngine } from "@logistack/contracts";
import {
	DUMP_EXTENSION,
	decrypt,
	dockerName,
	dumpScript,
	restoreScript,
} from "@logistack/core";
import { envVar, service } from "@logistack/db";
import {
	type DatabaseClient,
	type DocumentClient,
	databaseClient,
	type KeyValueClient,
	type SqlClient,
} from "@logistack/providers";
import {
	ExecFailed,
	feed,
	NodeRunnerError,
	tail,
} from "@logistack/worker/node-runner";
import type { RedisClient } from "bun";
import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { recordAudit } from "./audit.ts";
import { type Cluster, cluster } from "./cluster.ts";
import type { Deps, Env } from "./env.ts";
import { Failure, notFound } from "./errors.ts";
import { parseJson } from "./events.ts";
import { redisFor } from "./redis.ts";
import { runningTask } from "./routes/service-ops.ts";

const ports: Record<DatabaseEngine, number> = {
	postgres: 5432,
	mysql: 3306,
	mariadb: 3306,
	mongo: 27017,
	redis: 6379,
	libsql: 8080,
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
	/** The database the login opens when none is asked for. */
	defaultDatabase: string;
};

/** Engines whose explorer can open another database of the same instance. */
const MULTI_DATABASE = new Set<DatabaseEngine>([
	"postgres",
	"mysql",
	"mariadb",
]);

const ENV_KEYS = [
	"POSTGRES_USER",
	"POSTGRES_PASSWORD",
	"POSTGRES_DB",
	"MYSQL_ROOT_PASSWORD",
	"MYSQL_DATABASE",
	"MARIADB_ROOT_PASSWORD",
	"MARIADB_DATABASE",
	"MONGO_INITDB_ROOT_USERNAME",
	"MONGO_INITDB_ROOT_PASSWORD",
	"MONGO_INITDB_DATABASE",
	"REDIS_PASSWORD",
	"LIBSQL_AUTH_TOKEN",
];

type Login = {
	user: string;
	/** The env key the password comes from, named when it is missing. */
	passwordKey: string;
	password: string | undefined;
	database: string;
};

/** Who the explorer logs in as: the engine's superuser, from the env the image initialised with. */
const LOGIN: Partial<
	Record<DatabaseEngine, (env: Record<string, string>) => Login>
> = {
	postgres: (env) => {
		const user = env.POSTGRES_USER || "postgres";
		return {
			user,
			passwordKey: "POSTGRES_PASSWORD",
			password: env.POSTGRES_PASSWORD,
			database: env.POSTGRES_DB || user,
		};
	},
	mysql: (env) => ({
		user: "root",
		passwordKey: "MYSQL_ROOT_PASSWORD",
		password: env.MYSQL_ROOT_PASSWORD,
		database: env.MYSQL_DATABASE ?? "",
	}),
	mariadb: (env) => ({
		user: "root",
		passwordKey: "MARIADB_ROOT_PASSWORD",
		password: env.MARIADB_ROOT_PASSWORD || env.MYSQL_ROOT_PASSWORD,
		database: env.MARIADB_DATABASE || env.MYSQL_DATABASE || "",
	}),
	// Authenticates against `admin`; the database only names the one the tab opens first.
	mongo: (env) => ({
		user: env.MONGO_INITDB_ROOT_USERNAME || "root",
		passwordKey: "MONGO_INITDB_ROOT_PASSWORD",
		password: env.MONGO_INITDB_ROOT_PASSWORD,
		database: env.MONGO_INITDB_DATABASE ?? "",
	}),
	// requirepass only: the default user, no name.
	redis: (env) => ({
		user: "",
		passwordKey: "REDIS_PASSWORD",
		password: env.REDIS_PASSWORD,
		database: "0",
	}),
	// sqld checks a signed JWT; the full-access one is the "password".
	libsql: (env) => ({
		user: "",
		passwordKey: "LIBSQL_AUTH_TOKEN",
		password: env.LIBSQL_AUTH_TOKEN,
		database: "main",
	}),
};

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

async function databaseRow(c: Context<Env>, serviceId: string) {
	const [row] = await c.var.deps.db
		.select({ slug: service.slug, spec: service.spec })
		.from(service)
		.where(eq(service.id, serviceId));
	if (!row) throw notFound("service");
	if (row.spec.kind !== "database")
		throw new Failure("bad_request", "not a database service");
	return { slug: row.slug, engine: row.spec.engine };
}

// One pool per service and database, replaced when the credentials change. Pools close idle connections themselves.
// shortcut: a pool per database name ever asked for stays in the map (with no open connection once idle); evict on `missing` if names get abused.
const clients = new Map<string, { key: string; client: DatabaseClient }>();
const poolKey = (serviceId: string, database: string) =>
	`${serviceId}\0${database}`;

/** Closes and forgets the pool on one database of a service, e.g. before it is dropped. */
export async function closeDatabase(serviceId: string, database: string) {
	const cached = clients.get(poolKey(serviceId, database));
	clients.delete(poolKey(serviceId, database));
	await cached?.client.close().catch(() => {});
}

/**
 * The database service behind `serviceId` with a pooled client logged in as its superuser.
 * On Postgres, MySQL and MariaDB `database` opens that database (MySQL: the session's default
 * schema) instead of the login's own; other engines ignore it.
 */
export async function openDatabase(
	c: Context<Env>,
	serviceId: string,
	database?: string,
): Promise<DatabaseService> {
	const deps = c.var.deps;
	const { slug, engine } = await databaseRow(c, serviceId);
	const login = LOGIN[engine];
	if (!login)
		throw new Failure(
			"bad_request",
			`the explorer does not support ${engine} yet`,
		);
	const {
		user,
		passwordKey,
		password,
		database: defaultDatabase,
	} = login(await credentials(deps, serviceId));
	const target =
		database && MULTI_DATABASE.has(engine) ? database : defaultDatabase;
	if (!password)
		throw new Failure(
			"conflict",
			`${passwordKey} is missing from the service env`,
		);
	const conn = {
		engine,
		...(deps.databaseEndpoint ?? defaultDatabaseEndpoint)(
			serviceId,
			ports[engine],
		),
		user,
		password,
		database: target,
		statementTimeoutMs: deps.databaseStatementTimeoutMs,
	};
	const key = Bun.hash(JSON.stringify(conn)).toString(16);
	const slot = poolKey(serviceId, target);
	let cached = clients.get(slot);
	if (cached?.key !== key) {
		cached?.client.close().catch(() => {});
		cached = { key, client: databaseClient(conn) };
		clients.set(slot, cached);
	}
	return {
		id: serviceId,
		slug,
		engine,
		client: cached.client,
		defaultDatabase,
	};
}

/** The client of a SQL engine; Mongo has collections and Redis keys, not tables. */
export function sqlClient(db: DatabaseService): SqlClient {
	if (db.client.kind !== "sql")
		throw new Failure("bad_request", `${db.engine} has no tables or SQL`);
	return db.client;
}

export function documentClient(db: DatabaseService): DocumentClient {
	if (db.client.kind !== "document")
		throw new Failure("bad_request", `${db.engine} has no collections`);
	return db.client;
}

export function keyValueClient(db: DatabaseService): KeyValueClient {
	if (db.client.kind !== "kv")
		throw new Failure("bad_request", `${db.engine} has no keys`);
	return db.client;
}

const RUN_KEY = (runId: string) => `ls:db-run:${runId}`;
const RUN_CANCEL_CHANNEL = "ls:db-run:cancel";
/** How long a run's record outlives a replica that died mid-run. */
const RUN_TTL_S = 6 * 3600;

export type Runs = ReturnType<typeof createRuns>;

/**
 * Cancellable runs across api replicas: the owner record lives in Redis so a cancel can land on
 * any replica, and the replica running the query aborts it when the cancel is broadcast.
 */
export function createRuns(redis: RedisClient, shared: Cluster) {
	const local = new Map<string, AbortController>();
	const ready = shared.on(RUN_CANCEL_CHANNEL, (m) => {
		const runId = (m as { runId?: unknown } | null)?.runId;
		if (typeof runId === "string") local.get(runId)?.abort();
	});
	return {
		/** Runs `fn` under `runId` (when given) so `owner.actorId` can cancel it from any replica. */
		async run<T>(
			owner: { serviceId: string; actorId: string },
			runId: string | undefined,
			fn: (signal: AbortSignal) => Promise<T>,
		): Promise<T> {
			const abort = new AbortController();
			if (!runId) return fn(abort.signal);
			await ready;
			const taken = await redis.send("SET", [
				RUN_KEY(runId),
				JSON.stringify(owner),
				"NX",
				"EX",
				String(RUN_TTL_S),
			]);
			if (taken !== "OK") throw new Failure("conflict", "run already started");
			local.set(runId, abort);
			try {
				return await fn(abort.signal);
			} finally {
				local.delete(runId);
				await redis.del(RUN_KEY(runId)).catch(() => {});
			}
		},
		/** Aborts a run of `actorId` on `serviceId`; false when there is none (finished, or not theirs). */
		async cancel(serviceId: string, actorId: string, runId: string) {
			const raw = await redis.get(RUN_KEY(runId));
			const owner = (raw ? parseJson(raw) : undefined) as
				| { serviceId?: string; actorId?: string }
				| undefined;
			if (owner?.serviceId !== serviceId || owner.actorId !== actorId)
				return false;
			await shared.publish(RUN_CANCEL_CHANNEL, { runId });
			return true;
		},
	};
}

const runsByUrl = new Map<string, Runs>();
const runsFor = (url: string) => {
	let found = runsByUrl.get(url);
	if (!found) {
		found = createRuns(redisFor(url), cluster(url));
		runsByUrl.set(url, found);
	}
	return found;
};

/** Runs a script under `runId` (when given) so its own actor can cancel it, from any replica. */
export function runQuery(
	redisUrl: string,
	db: DatabaseService,
	actorId: string,
	input: { sql: string; readOnly: boolean; runId?: string },
) {
	return runsFor(redisUrl).run(
		{ serviceId: db.id, actorId },
		input.runId,
		(signal) =>
			sqlClient(db).query(input.sql, { readOnly: input.readOnly, signal }),
	);
}

/** Aborts a run of `actorId` on `serviceId`; false when there is none (finished, or not theirs). */
export const cancelRun = (
	redisUrl: string,
	serviceId: string,
	actorId: string,
	runId: string,
) => runsFor(redisUrl).cancel(serviceId, actorId, runId);

const DUMP_TIMEOUT_S = 6 * 3600;

/** `<slug>-<YYYYMMDD-HHmmss>.<ext>`, in UTC. */
export function dumpFilename(slug: string, engine: DatabaseEngine, at: Date) {
	const stamp = at
		.toISOString()
		.replace(/[-:]/g, "")
		.replace("T", "-")
		.slice(0, 15);
	return `${slug}-${stamp}.${DUMP_EXTENSION[engine]}`;
}

const nodeFailure = (e: unknown) =>
	e instanceof NodeRunnerError
		? new Failure("conflict", e.message, { reason: e.code })
		: e;

/** The replica a dump or restore runs in. */
async function replica(c: Context<Env>, serviceId: string) {
	const task = await runningTask(c, serviceId);
	if (!task)
		throw new Failure("conflict", "the database has no running replica", {
			reason: "not_running",
		});
	return task;
}

/** What a dump checks before it starts: a database service with a running replica. */
export async function dumpTarget(c: Context<Env>, serviceId: string) {
	return {
		...(await databaseRow(c, serviceId)),
		task: await replica(c, serviceId),
	};
}

/**
 * Streams the engine's dump tool out of the running replica as an attachment. Errors before the
 * first byte are ordinary JSON errors. A failure after it errors the body stream, so the response
 * ends without its terminating chunk and clients (browsers, curl) mark the download failed
 * instead of keeping a truncated file. Audited when the stream ends, with its size.
 */
export async function dumpResponse(
	c: Context<Env>,
	serviceId: string,
): Promise<Response> {
	const { slug, engine, task } = await dumpTarget(c, serviceId);
	const filename = dumpFilename(slug, engine, new Date());
	const started = Date.now();
	let bytes = 0;
	let stderr = "";
	let audited = false;
	/** One row per dump, however it ends: done, failed, or dropped by the client. */
	const audit = async (error?: unknown) => {
		if (audited) return;
		audited = true;
		await recordAudit(c, {
			action: "database.dump",
			resourceId: serviceId,
			diff: {
				filename,
				taskId: task.id,
				bytes,
				durationMs: Date.now() - started,
				...(error !== undefined && {
					error: error instanceof Error ? error.message : String(error),
				}),
			},
			outcome: error === undefined ? "success" : "error",
		});
	};
	const job = c.var.deps.nodes.runJob(
		task.nodeId,
		{
			kind: "exec",
			target: { kind: "task", taskId: task.id },
			cmd: ["sh"],
			script: dumpScript(engine),
			timeoutSec: DUMP_TIMEOUT_S,
			outputLimitBytes: Number.MAX_SAFE_INTEGER,
		},
		{ signal: c.req.raw.signal },
	);
	const it = job[Symbol.asyncIterator]();
	const dec = new TextDecoder();
	/** The next stdout chunk; at the end, undefined or `ExecFailed` on a non-zero exit. */
	const next = async (): Promise<Uint8Array | undefined> => {
		for (;;) {
			const r = await it.next();
			if (r.done) {
				const { exitCode } = await job.result;
				if (exitCode !== 0) throw new ExecFailed(exitCode, stderr.trim());
				return undefined;
			}
			if (r.value.stream === "stdout") {
				bytes += r.value.data.byteLength;
				return r.value.data;
			}
			stderr = tail(stderr + dec.decode(r.value.data, { stream: true }), 4000);
		}
	};

	let first: Uint8Array | undefined;
	try {
		first = await next();
	} catch (e) {
		await audit(e);
		if (e instanceof ExecFailed)
			throw new Failure("conflict", `the dump failed (exit ${e.code})`, {
				reason: "tool_failed",
				exitCode: e.code,
				stderr: e.stderr,
			});
		throw nodeFailure(e);
	}
	if (!first) await audit();
	const body = new ReadableStream<Uint8Array>({
		start(ctrl) {
			if (first) ctrl.enqueue(first);
			else ctrl.close();
		},
		async pull(ctrl) {
			try {
				const data = await next();
				if (data) return ctrl.enqueue(data);
				ctrl.close();
				await audit();
			} catch (e) {
				ctrl.error(e);
				await audit(e);
			}
		},
		async cancel() {
			await audit("the client stopped the download");
			await it.return?.();
		},
	});
	return new Response(body, {
		headers: {
			"content-type": "application/octet-stream",
			"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
			"x-content-type-options": "nosniff",
			"cache-control": "private, no-store",
		},
	});
}

/**
 * Pipes `body` into the engine's restore tool in the running replica, replacing what the
 * database holds. A non-zero exit is a 409 with the tool's exit code and the tail of its stderr.
 */
export async function restoreFrom(
	c: Context<Env>,
	serviceId: string,
	body: ReadableStream<Uint8Array>,
) {
	const db = await databaseRow(c, serviceId);
	if (db.engine === "redis" || db.engine === "libsql")
		throw new Failure(
			"bad_request",
			`restore is not supported for ${db.engine}`,
		);
	const task = await replica(c, serviceId);
	const exec = c.var.deps.nodes.exec(
		task.nodeId,
		{
			target: { kind: "task", taskId: task.id },
			cmd: ["sh", "-c", restoreScript(db.engine)],
			stdin: true,
		},
		{ signal: c.req.raw.signal },
	);
	let bytes = 0;
	try {
		await feed(exec, body, (n) => {
			bytes = n;
		});
	} catch (e) {
		if (e instanceof ExecFailed)
			throw new Failure("conflict", `the restore failed (exit ${e.code})`, {
				reason: "tool_failed",
				exitCode: e.code,
				stderr: e.stderr,
			});
		throw nodeFailure(e);
	}
	return { bytes };
}
