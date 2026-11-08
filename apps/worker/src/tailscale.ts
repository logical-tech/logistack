import { decrypt, dockerName } from "@logistack/core";
import {
	environment,
	service,
	tailscaleNetwork,
	tailscalePublication,
} from "@logistack/db";
import {
	type Labels,
	managedLabels,
	type ServiceSpec,
} from "@logistack/docker";
import { eq } from "drizzle-orm";
import { inspectService, upsertService } from "./apply.ts";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";
import { envNetworkName, svcName } from "./load.ts";

/** On every service and config this module creates; cleanup lists by it and nothing else. */
export const TAILSCALE_LABEL = "logistack.tailscale";
const SERVE_PATH = "/etc/logistack/tailscale-serve.json";

const withHash = (spec: ServiceSpec, labels: Labels): ServiceSpec => ({
	...spec,
	Labels: {
		...labels,
		"logistack.spec-hash": Bun.hash(JSON.stringify(spec)).toString(16),
	},
});

/**
 * Pure: tailscaled on every node, on the host network so the node itself joins the tailnet.
 * Userspace networking needs no TUN device or capabilities; with no state dir, containerboot
 * keeps state in memory, so nothing is left on disk when the service goes.
 */
export function compileTailscaleNode(i: {
	name: string;
	image: string;
	authKey: string;
	labels: Labels;
}): ServiceSpec {
	return withHash(
		{
			Name: i.name,
			Labels: i.labels,
			TaskTemplate: {
				ContainerSpec: {
					Image: i.image,
					Labels: i.labels,
					// The key goes through env, never argv; Swarm expands the node template per task.
					Env: [
						`TS_AUTHKEY=${i.authKey}`,
						"TS_USERSPACE=true",
						"TS_ACCEPT_DNS=false",
						"TS_HOSTNAME={{.Node.Hostname}}",
					],
				},
				RestartPolicy: { Condition: "any", Delay: 5e9 },
				Networks: [{ Target: "host" }],
			},
			Mode: { Global: {} },
		},
		i.labels,
	);
}

/** Pure: the `tailscale serve` config proxying the machine's tailnet name to `target`. */
export function serveConfig(target: string, https: boolean): string {
	const port = https ? "443" : "80";
	return JSON.stringify({
		TCP: { [port]: https ? { HTTPS: true } : { HTTP: true } },
		// containerboot substitutes the machine's MagicDNS name.
		Web: {
			[`\${TS_CERT_DOMAIN}:${port}`]: { Handlers: { "/": { Proxy: target } } },
		},
	});
}

/** Pure: one tailnet machine per publication, beside the service on its environment network. */
export function compileTailscalePublisher(i: {
	name: string;
	image: string;
	authKey: string;
	hostname: string;
	network: string;
	config: { id: string; name: string };
	labels: Labels;
}): ServiceSpec {
	return withHash(
		{
			Name: i.name,
			Labels: i.labels,
			TaskTemplate: {
				ContainerSpec: {
					Image: i.image,
					Labels: i.labels,
					Env: [
						`TS_AUTHKEY=${i.authKey}`,
						"TS_USERSPACE=true",
						"TS_ACCEPT_DNS=false",
						`TS_HOSTNAME=${i.hostname}`,
						`TS_SERVE_CONFIG=${SERVE_PATH}`,
					],
					Configs: [
						{
							File: { Name: SERVE_PATH, UID: "0", GID: "0", Mode: 0o444 },
							ConfigID: i.config.id,
							ConfigName: i.config.name,
						},
					],
				},
				RestartPolicy: { Condition: "any", Delay: 5e9 },
				Networks: [{ Target: i.network }],
			},
			Mode: { Replicated: { Replicas: 1 } },
		},
		i.labels,
	);
}

/**
 * Converges Tailscale to Postgres: a global tailscaled per organization that turned it on, a
 * publisher per publication of a running service, and nothing else carrying our label.
 */
export async function syncTailscale(ctx: Ctx): Promise<void> {
	const prefix = ctx.cfg.LS_NAME_PREFIX;
	const networks = await ctx.db.select().from(tailscaleNetwork);
	const pubs = await ctx.db
		.select({ p: tailscalePublication, s: service })
		.from(tailscalePublication)
		.innerJoin(service, eq(service.id, tailscalePublication.serviceId))
		.innerJoin(environment, eq(environment.id, service.environmentId));
	const byOrg = new Map(networks.map((n) => [n.organizationId, n]));
	const live = pubs.filter(
		({ p, s }) => byOrg.has(p.organizationId) && s.desiredState === "running",
	);
	const labelsOf = (resource: string, org: string): Labels => ({
		...managedLabels({ resource, kind: "system", org }),
		[TAILSCALE_LABEL]: "true",
		...scope(ctx).labels,
	});

	const wanted = new Set([
		...networks.map((n) => `${prefix}${dockerName("tsn", n.id)}`),
		...live.map(({ p }) => `${prefix}${dockerName("tsp", p.id)}`),
	]);
	const filters = { label: [`${TAILSCALE_LABEL}=true`, ...scopeFilters(ctx)] };
	for (const s of await ctx.docker.services.list(filters))
		if (!wanted.has(s.Spec.Name)) {
			await ctx.docker.services.remove(s.ID);
			log("info", "tailscale service removed", { name: s.Spec.Name });
		}

	const keys = new Map<string, string>();
	for (const n of networks) {
		let problem: string | null = null;
		let serviceId = n.nodeServiceId;
		try {
			const authKey = await decrypt(ctx.masterKey, n.authKeyEncrypted);
			keys.set(n.organizationId, authKey);
			const spec = compileTailscaleNode({
				name: `${prefix}${dockerName("tsn", n.id)}`,
				image: ctx.cfg.LS_TAILSCALE_IMAGE,
				authKey,
				labels: labelsOf(n.id, n.organizationId),
			});
			serviceId = (await converge(ctx, spec)) ?? serviceId;
		} catch (e) {
			problem = e instanceof Error ? e.message : String(e);
			log("warn", "tailscale node sync failed", { id: n.id, error: problem });
		}
		if (problem !== n.statusMessage || serviceId !== n.nodeServiceId)
			await ctx.db
				.update(tailscaleNetwork)
				.set({ statusMessage: problem, nodeServiceId: serviceId })
				.where(eq(tailscaleNetwork.id, n.id));
	}

	const configs = await ctx.docker.configs.list(filters);
	const used = new Set<string>();
	for (const { p, s } of live) {
		let problem: string | null = null;
		try {
			const authKey = keys.get(p.organizationId);
			if (!authKey) throw new Error("the tailnet auth key could not be read");
			const data = serveConfig(
				`http://${svcName(ctx, s.id)}:${p.port}`,
				p.https,
			);
			// Configs are immutable: the content hash in the name rolls the publisher on change.
			const configName = `${prefix}${dockerName("tsp", p.id)}-${Bun.hash(data).toString(16).slice(0, 10)}`;
			used.add(configName);
			const labels = labelsOf(p.id, p.organizationId);
			const configId =
				configs.find((c) => c.Spec.Name === configName)?.ID ??
				(
					await ctx.docker.configs.create({
						Name: configName,
						Labels: labels,
						Data: data,
					})
				).ID;
			await converge(
				ctx,
				compileTailscalePublisher({
					name: `${prefix}${dockerName("tsp", p.id)}`,
					image: ctx.cfg.LS_TAILSCALE_IMAGE,
					authKey,
					hostname: p.hostname,
					network: envNetworkName(ctx, s.environmentId),
					config: { id: configId, name: configName },
					labels,
				}),
			);
		} catch (e) {
			problem = e instanceof Error ? e.message : String(e);
			log("warn", "tailscale publication sync failed", {
				id: p.id,
				error: problem,
			});
		}
		if (problem !== p.statusMessage)
			await ctx.db
				.update(tailscalePublication)
				.set({ statusMessage: problem })
				.where(eq(tailscalePublication.id, p.id));
	}
	// After the services moved off them: a config in use cannot be removed.
	for (const c of configs)
		if (!used.has(c.Spec.Name))
			await ctx.docker.configs.remove(c.ID).catch((e: unknown) =>
				log("warn", "tailscale config removal failed", {
					name: c.Spec.Name,
					error: String(e),
				}),
			);
}

/** Creates or updates `spec` when its hash changed; returns the Swarm service id. */
async function converge(ctx: Ctx, spec: ServiceSpec) {
	const hash = spec.Labels?.["logistack.spec-hash"];
	const current = await inspectService(ctx, spec.Name);
	if (current && current.Spec.Labels?.["logistack.spec-hash"] === hash)
		return current.ID;
	await upsertService(ctx, undefined, spec);
	log(
		"info",
		current ? "tailscale service updated" : "tailscale service created",
		{
			name: spec.Name,
		},
	);
	return (await inspectService(ctx, spec.Name))?.ID;
}

/** Narrows listings to this worker's own objects when tests run side by side. */
const scopeFilters = (ctx: Ctx) =>
	Object.entries(scope(ctx).labels).map(([k, v]) => `${k}=${v}`);
