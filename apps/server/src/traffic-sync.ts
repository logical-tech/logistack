import type { TrafficConfig } from "@logistack/contracts";
import { type Db, domain, environment, project, service } from "@logistack/db";
import { RedisClient } from "bun";
import { eq, isNull } from "drizzle-orm";
import type { Agents } from "./agent-gateway.ts";
import { log } from "./log.ts";
import { PROXY_SYNC_CHANNEL } from "./redis.ts";

/** Visitor hash salt of one UTC day. Kept 48 h, then gone: hashes from that day can never be linked again. */
export const SALT_KEY = (day: string) => `ls:traffic:salt:${day}`;
const SALT_TTL_SEC = 48 * 3600;
/** Covers midnight (tomorrow's salt is sent ahead) and domains added without a proxy sync. */
const REFRESH_MS = 60_000;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The day's salt, created by whichever replica asks first. */
export async function saltFor(
	redis: RedisClient,
	day: string,
): Promise<string> {
	const fresh = Buffer.from(
		crypto.getRandomValues(new Uint8Array(16)),
	).toString("hex");
	await redis.send("SET", [
		SALT_KEY(day),
		fresh,
		"NX",
		"EX",
		String(SALT_TTL_SEC),
	]);
	return (await redis.get(SALT_KEY(day))) ?? fresh;
}

export async function buildTrafficConfig(
	db: Db,
	redis: RedisClient,
	caddyService: string,
	now = Date.now(),
): Promise<TrafficConfig> {
	const rows = await db
		.select({
			hostname: domain.hostname,
			pathPrefix: domain.pathPrefix,
			domainId: domain.id,
			serviceId: domain.serviceId,
			organizationId: project.organizationId,
			script: domain.webAnalytics,
		})
		.from(domain)
		.innerJoin(service, eq(service.id, domain.serviceId))
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		// A redirect domain only answers 308s; its traffic says nothing about the service.
		.where(isNull(domain.redirectTo));
	const salts: Record<string, string> = {};
	for (const day of [dayOf(now), dayOf(now + 86_400_000)])
		salts[day] = await saltFor(redis, day);
	return {
		caddyService,
		salts,
		routes: rows.map((r) => ({ ...r, pathPrefix: r.pathPrefix ?? undefined })),
	};
}

/** Keeps every agent this replica holds on the current routes and salts. */
export async function startTrafficSync(opts: {
	db: Db;
	agents: Agents;
	redisUrl: string;
	caddyService: string;
	refreshMs?: number;
}) {
	const redis = new RedisClient(opts.redisUrl);
	let current: { config: TrafficConfig; json: string } | undefined;
	let building: Promise<void> | undefined;
	let again = false;

	async function rebuild() {
		const config = await buildTrafficConfig(opts.db, redis, opts.caddyService);
		const json = JSON.stringify(config);
		if (json === current?.json) return;
		current = { config, json };
		for (const n of opts.agents.connected())
			opts.agents.pushTraffic(n.nodeId, config);
	}

	const refresh = (): Promise<void> => {
		if (building) {
			again = true;
			return building;
		}
		building = (async () => {
			do {
				again = false;
				await rebuild().catch((e) =>
					log("error", "traffic sync failed", { error: String(e) }),
				);
			} while (again);
		})().finally(() => {
			building = undefined;
		});
		return building;
	};

	const unwatch = opts.agents.watch((nodeId, connected) => {
		if (!connected) return;
		if (current) opts.agents.pushTraffic(nodeId, current.config);
		else void refresh();
	});
	// Every domain change already asks for a proxy sync; the same signal refreshes the routes.
	const sub = new RedisClient(opts.redisUrl);
	await sub.subscribe(PROXY_SYNC_CHANNEL, () => void refresh());
	const timer = setInterval(() => void refresh(), opts.refreshMs ?? REFRESH_MS);
	await refresh();

	return {
		refresh,
		close() {
			clearInterval(timer);
			unwatch();
			sub.close();
			redis.close();
		},
	};
}
