import { type DrainsConfig, LogDrainConfig } from "@logistack/contracts";
import { decrypt } from "@logistack/core";
import {
	type Db,
	environment,
	logDrain,
	organization,
	project,
	service,
} from "@logistack/db";
import { RedisClient } from "bun";
import { and, eq, inArray, or } from "drizzle-orm";
import type { Agents } from "./agent-gateway.ts";
import { log } from "./log.ts";

/** Published after any drain change; every api replica re-pushes to the agents it holds. */
export const DRAINS_CHANGED = "ls:drains:changed";
/** Also catches services created in a drained project since the last change. */
const REFRESH_MS = 60_000;

/** Every enabled drain of every organization: any node may run any organization's services. */
export async function buildDrainsConfig(
	db: Db,
	masterKey: CryptoKey,
): Promise<DrainsConfig> {
	const rows = await db
		.select()
		.from(logDrain)
		.where(eq(logDrain.enabled, true));
	const drains: DrainsConfig["drains"] = [];
	const routes: DrainsConfig["routes"] = {};
	for (const d of rows) {
		const config = LogDrainConfig.safeParse(
			JSON.parse(await decrypt(masterKey, d.configEncrypted)),
		);
		if (!config.success) {
			log("warn", "skipping a log drain with an invalid config", { id: d.id });
			continue;
		}
		if (d.projectIds.length === 0 && d.serviceIds.length === 0) continue;
		drains.push({ id: d.id, config: config.data });
		const services = await db
			.select({
				serviceId: service.id,
				service: service.name,
				environmentId: environment.id,
				environment: environment.name,
				projectId: project.id,
				project: project.name,
				organizationId: organization.id,
				organization: organization.name,
			})
			.from(service)
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.innerJoin(project, eq(project.id, environment.projectId))
			.innerJoin(organization, eq(organization.id, project.organizationId))
			.where(
				and(
					eq(project.organizationId, d.organizationId),
					or(
						d.projectIds.length ? inArray(project.id, d.projectIds) : undefined,
						d.serviceIds.length ? inArray(service.id, d.serviceIds) : undefined,
					),
				),
			);
		for (const meta of services) {
			const route = routes[meta.serviceId];
			if (route) route.drainIds.push(d.id);
			else routes[meta.serviceId] = { meta, drainIds: [d.id] };
		}
	}
	return { drains, routes };
}

export async function notifyDrainsChanged(redis: RedisClient) {
	await redis
		.publish(DRAINS_CHANGED, "1")
		.catch((e) =>
			log("warn", "could not announce a drain change", { error: String(e) }),
		);
}

/** Keeps every agent this replica holds on the current drain setup. */
export async function startDrainSync(opts: {
	db: Db;
	masterKey: CryptoKey;
	agents: Agents;
	redisUrl: string;
	refreshMs?: number;
}) {
	let current: { config: DrainsConfig; json: string } | undefined;
	let building: Promise<void> | undefined;
	let again = false;

	async function rebuild(force: boolean) {
		const config = await buildDrainsConfig(opts.db, opts.masterKey);
		const json = JSON.stringify(config);
		const changed = json !== current?.json;
		current = { config, json };
		if (changed || force)
			for (const n of opts.agents.connected())
				opts.agents.pushDrains(n.nodeId, config);
	}

	/** A change during a rebuild runs one more, so the last one always wins. */
	const refresh = (force: boolean): Promise<void> => {
		if (building) {
			again = true;
			return building;
		}
		building = (async () => {
			do {
				again = false;
				await rebuild(force).catch((e) =>
					log("error", "log drain sync failed", { error: String(e) }),
				);
			} while (again);
		})().finally(() => {
			building = undefined;
		});
		return building;
	};

	const unwatch = opts.agents.watch((nodeId, connected) => {
		if (!connected) return;
		if (current) opts.agents.pushDrains(nodeId, current.config);
		else void refresh(false);
	});
	const sub = new RedisClient(opts.redisUrl);
	await sub.subscribe(DRAINS_CHANGED, () => void refresh(false));
	const timer = setInterval(
		() => void refresh(false),
		opts.refreshMs ?? REFRESH_MS,
	);
	await refresh(true);

	return {
		refresh,
		close() {
			clearInterval(timer);
			unwatch();
			sub.close();
		},
	};
}
