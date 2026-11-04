import { decrypt, dockerName } from "@logistack/core";
import {
	cloudflareTunnel,
	dnsProvider,
	domain,
	environment,
	project,
	service,
} from "@logistack/db";
import {
	type Labels,
	managedLabels,
	type ServiceSpec,
} from "@logistack/docker";
import {
	cloudflare,
	cloudflareTunnels,
	findZoneForHostname,
	instantiate,
	tunnelIngress,
	tunnelTarget,
} from "@logistack/providers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { inspectService, upsertService } from "./apply.ts";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";

const TUNNEL_LABEL = "logistack.tunnel";

export type CloudflaredInput = {
	name: string;
	image: string;
	token: string;
	network: string;
	labels: Labels;
};

/** Pure: the Swarm service running one tunnel's connector. Its hash label skips no-op updates. */
export function compileCloudflared(i: CloudflaredInput): ServiceSpec {
	const spec: ServiceSpec = {
		Name: i.name,
		Labels: i.labels,
		TaskTemplate: {
			ContainerSpec: {
				Image: i.image,
				Labels: i.labels,
				Args: ["tunnel", "--no-autoupdate", "run"],
				// cloudflared reads the token from env, so it never shows in argv.
				Env: [`TUNNEL_TOKEN=${i.token}`],
			},
			RestartPolicy: { Condition: "any", Delay: 5e9 },
			Networks: [{ Target: i.network }],
		},
		Mode: { Replicated: { Replicas: 1 } },
	};
	return {
		...spec,
		Labels: {
			...i.labels,
			"logistack.spec-hash": Bun.hash(JSON.stringify(spec)).toString(16),
		},
	};
}

const ZoneList = z.array(z.object({ id: z.string(), name: z.string() }));

/**
 * Converges every Cloudflare Tunnel to Postgres: a cloudflared per tunnel row (none for a
 * removed one), the tunnel's ingress listing its domains, and a proxied CNAME per domain.
 * Tunnel traffic enters Caddy over plain HTTP; Caddy routes it like any other host.
 */
export async function syncTunnels(ctx: Ctx): Promise<void> {
	const rows = await ctx.db
		.select({ t: cloudflareTunnel, p: dnsProvider })
		.from(cloudflareTunnel)
		.innerJoin(dnsProvider, eq(dnsProvider.id, cloudflareTunnel.dnsProviderId));
	const names = new Set(
		rows.map((r) => `${ctx.cfg.LS_NAME_PREFIX}${dockerName("cft", r.t.id)}`),
	);
	const running = await ctx.docker.services.list({
		label: [`${TUNNEL_LABEL}=true`, ...scopeFilters(ctx)],
	});
	for (const s of running)
		if (!names.has(s.Spec.Name)) {
			await ctx.docker.services.remove(s.ID);
			log("info", "cloudflared removed", { name: s.Spec.Name });
		}

	const origin = `http://${ctx.cfg.LS_CADDY_SERVICE}:80`;
	for (const { t, p } of rows) {
		let problem: string | null = null;
		try {
			const name = `${ctx.cfg.LS_NAME_PREFIX}${dockerName("cft", t.id)}`;
			const spec = compileCloudflared({
				name,
				image: ctx.cfg.LS_CLOUDFLARED_IMAGE,
				token: await decrypt(ctx.masterKey, t.tokenEncrypted),
				network: ctx.cfg.LS_INGRESS_NETWORK,
				labels: {
					...managedLabels({
						resource: t.id,
						kind: "system",
						org: t.organizationId,
					}),
					[TUNNEL_LABEL]: "true",
					...scope(ctx).labels,
				},
			});
			const current = await inspectService(ctx, name);
			if (
				current?.Spec.Labels?.["logistack.spec-hash"] !==
				spec.Labels?.["logistack.spec-hash"]
			) {
				await upsertService(ctx, undefined, spec);
				log("info", current ? "cloudflared updated" : "cloudflared created", {
					name,
				});
			}

			const credentials = JSON.parse(
				await decrypt(ctx.masterKey, p.credentialsEncrypted),
			) as { apiToken: string };
			const domains = await ctx.db
				.select({ d: domain })
				.from(domain)
				.innerJoin(service, eq(service.id, domain.serviceId))
				.innerJoin(environment, eq(environment.id, service.environmentId))
				.innerJoin(project, eq(project.id, environment.projectId))
				.where(
					and(
						eq(domain.dnsProviderId, t.dnsProviderId),
						eq(domain.tunnel, true),
						eq(service.desiredState, "running"),
					),
				);
			await cloudflareTunnels(credentials.apiToken).putIngress(
				t.accountId,
				t.tunnelId,
				tunnelIngress(
					domains.map(({ d }) => d.hostname),
					origin,
				),
			);

			const dns = instantiate(cloudflare, credentials);
			const zones = ZoneList.catch([]).parse(p.zonesCache);
			for (const { d } of domains) {
				if (d.dnsRecordId) continue;
				const zone = findZoneForHostname(d.hostname, zones);
				if (!zone) {
					problem = `${p.name} does not manage a zone for ${d.hostname}`;
					continue;
				}
				const record = await dns.upsertRecord({
					zoneId: zone.id,
					name: d.hostname,
					type: "CNAME",
					content: tunnelTarget(t.tunnelId),
					ttl: 1,
					proxied: true,
				});
				await ctx.db
					.update(domain)
					.set({ dnsRecordId: record.id })
					.where(eq(domain.id, d.id));
			}
		} catch (e) {
			problem = e instanceof Error ? e.message : String(e);
			log("warn", "tunnel sync failed", { tunnel: t.id, error: problem });
		}
		if (problem !== t.statusMessage)
			await ctx.db
				.update(cloudflareTunnel)
				.set({ statusMessage: problem })
				.where(eq(cloudflareTunnel.id, t.id));
	}
}

/** Narrows listings to this worker's own objects when tests run side by side. */
const scopeFilters = (ctx: Ctx) =>
	Object.entries(scope(ctx).labels).map(([k, v]) => `${k}=${v}`);
