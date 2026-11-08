import type { PluginStatus } from "@logistack/contracts";
import {
	compileEgressProxy,
	compilePlugin,
	decrypt,
	egressClientEnv,
	egressKey,
	egressNetworkName,
	egressPassword,
	egressProxyName,
	pluginServiceName,
	pluginsNetworkName,
} from "@logistack/core";
import { pluginInstall, registry } from "@logistack/db";
import {
	authForImage,
	LABEL_KIND,
	LABEL_MANAGED,
	LABEL_RESOURCE,
	type ServiceSpec,
} from "@logistack/docker";
import { eq } from "drizzle-orm";
import { ensureStackNetwork, inspectService, upsertService } from "./apply.ts";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";
import { gatewayImage } from "./db-access.ts";

// Converges plugin services to `plugin_install` (docs/plans/plugins.md, "Runtime"). Idempotent;
// runs every 30 s and after each install change.

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const withHash = (spec: ServiceSpec): ServiceSpec => ({
	...spec,
	Labels: {
		...spec.Labels,
		"logistack.spec-hash": Bun.hash(JSON.stringify(spec)).toString(16),
	},
});

/** Where the plugin calls the API: the api's stack service on the plugins network, unless overridden. */
export const pluginApiUrl = (ctx: Pick<Ctx, "cfg">) =>
	ctx.cfg.LS_PLUGIN_API_URL ??
	`http://${ctx.cfg.LS_STACK_NAME}_logistack-api:${ctx.cfg.LS_API_UPSTREAM.split(":")[1] ?? "3000"}`;

type Row = typeof pluginInstall.$inferSelect;

async function setStatus(
	ctx: Ctx,
	row: Row,
	status: PluginStatus,
	statusMessage: string | null,
) {
	if (row.status === status && row.statusMessage === statusMessage) return;
	await ctx.db
		.update(pluginInstall)
		.set({ status, statusMessage })
		.where(eq(pluginInstall.id, row.id));
}

async function pullAuth(ctx: Ctx, row: Row, image: string) {
	if (!row.registryId) return undefined;
	const [reg] = await ctx.db
		.select()
		.from(registry)
		.where(eq(registry.id, row.registryId));
	if (!reg?.username || !reg.passwordEncrypted) return undefined;
	return authForImage(image, {
		username: reg.username,
		password: await decrypt(ctx.masterKey, reg.passwordEncrypted),
		serveraddress: reg.url.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, ""),
	});
}

/** Plugin services of this install (and only this test scope). */
async function livePlugins(ctx: Ctx) {
	const label = [`${LABEL_MANAGED}=true`, `${LABEL_KIND}=plugin`];
	for (const [k, v] of Object.entries(scope(ctx).labels))
		label.push(`${k}=${v}`);
	return (await ctx.docker.services.list({ label })).filter((s) =>
		s.Spec.Name.startsWith(`${ctx.cfg.LS_NAME_PREFIX}ls-plg-`),
	);
}

let warnedOpen = false;

/**
 * The network's id; created as a stack network and attached to the api and worker on a stack
 * install. It is `internal`: plugins reach the internet only through the egress proxy.
 */
async function pluginsNetwork(ctx: Ctx): Promise<string> {
	const name = pluginsNetworkName(ctx.cfg.LS_NAME_PREFIX);
	await ensureStackNetwork(ctx, name, { internal: true });
	let existing = await ctx.docker.networks.inspect(name).catch(() => undefined);
	if (!existing) {
		// Dev machines and tests run the api outside Swarm: a plain attachable overlay is enough.
		await ctx.docker.networks
			.create({
				Name: name,
				Driver: "overlay",
				Attachable: true,
				Internal: true,
				Scope: "swarm",
				Labels: { [LABEL_MANAGED]: "true", ...scope(ctx).labels },
			})
			.catch(() => {});
		existing = await ctx.docker.networks.inspect(name);
	}
	// Created by a build before egress enforcement; Docker cannot flip the flag in place.
	if (!existing.Internal && !warnedOpen) {
		warnedOpen = true;
		log("warn", "the plugins network is not internal: egress is not enforced", {
			network: name,
			fix: "detach the api, worker and plugins from it and remove it; the worker recreates it internal",
		});
	}
	return existing.Id;
}

/** The ordinary overlay only the egress proxy joins, for its route out. */
async function egressNetwork(ctx: Ctx): Promise<string> {
	const name = egressNetworkName(ctx.cfg.LS_NAME_PREFIX);
	const existing = await ctx.docker.networks
		.inspect(name)
		.catch(() => undefined);
	if (existing) return existing.Id;
	await ctx.docker.networks
		.create({
			Name: name,
			Driver: "overlay",
			Scope: "swarm",
			Labels: { [LABEL_MANAGED]: "true", ...scope(ctx).labels },
		})
		.catch(() => {});
	return (await ctx.docker.networks.inspect(name)).Id;
}

/** Runs the egress proxy with every container install's declared hosts; removes it when none is left. */
async function reconcileEgressProxy(
	ctx: Ctx,
	rows: Row[],
	network: string,
	key: string,
) {
	const name = egressProxyName(ctx.cfg.LS_NAME_PREFIX);
	if (!rows.length) {
		const live = await inspectService(ctx, name);
		if (live) await ctx.docker.services.remove(live.ID).catch(() => {});
		return;
	}
	const image = await gatewayImage(ctx);
	if (!image) {
		log("warn", "no egress proxy image: plugins have no route out", {
			fix: "set LS_GATEWAY_IMAGE or run the worker in the LogiStack stack",
		});
		return;
	}
	const spec = withHash(
		compileEgressProxy({
			image,
			key,
			rules: Object.fromEntries(rows.map((r) => [r.id, r.manifest.egress])),
			networks: [network, await egressNetwork(ctx)],
			scope: scope(ctx),
		}),
	);
	const live = await inspectService(ctx, name);
	if (
		live?.Spec.Labels?.["logistack.spec-hash"] !==
		spec.Labels?.["logistack.spec-hash"]
	)
		await upsertService(ctx, undefined, spec);
}

export async function reconcilePlugins(ctx: Ctx) {
	const rows = await ctx.db.select().from(pluginInstall);
	const wanted = new Set(
		rows.filter((r) => r.image).map((r) => r.id as string),
	);
	for (const s of await livePlugins(ctx)) {
		const id = s.Spec.Labels?.[LABEL_RESOURCE];
		if (id && wanted.has(id)) continue;
		await ctx.docker.services.remove(s.ID).catch(() => {});
		log("info", "removed a plugin service", { name: s.Spec.Name });
	}
	const containers = rows.filter((r) => r.image);
	const network = containers.length ? await pluginsNetwork(ctx) : "";
	const key = await egressKey(ctx.cfg.LOGISTACK_MASTER_KEY);
	try {
		await reconcileEgressProxy(ctx, containers, network, key);
	} catch (e) {
		log("warn", "egress proxy reconcile failed", { error: errMsg(e) });
	}
	// Plugins call the api directly over the plugins network, never through the proxy.
	const apiHost = new URL(pluginApiUrl(ctx)).hostname;
	for (const row of rows) {
		if (!row.image) {
			// A dev-URL install has no container; the api checks its health on demand.
			await setStatus(ctx, row, row.enabled ? "running" : "disabled", null);
			continue;
		}
		try {
			if (!row.tokenEncrypted) {
				await setStatus(ctx, row, "error", "the install has no API token");
				continue;
			}
			const spec = withHash(
				compilePlugin({
					install: {
						id: row.id,
						organizationId: row.organizationId,
						image: row.image,
						enabled: row.enabled,
						manifest: row.manifest,
					},
					env: {
						LOGISTACK_URL: pluginApiUrl(ctx),
						LOGISTACK_TOKEN: await decrypt(ctx.masterKey, row.tokenEncrypted),
						LOGISTACK_SIGNING_SECRET: await decrypt(
							ctx.masterKey,
							row.signingSecretEncrypted,
						),
					},
					network,
					proxyEnv: egressClientEnv({
						installId: row.id,
						password: await egressPassword(key, row.id),
						noProxy: [apiHost],
						prefix: ctx.cfg.LS_NAME_PREFIX,
					}),
					scope: scope(ctx),
				}),
			);
			const live = await inspectService(
				ctx,
				pluginServiceName(row.id, ctx.cfg.LS_NAME_PREFIX),
			);
			if (
				live?.Spec.Labels?.["logistack.spec-hash"] !==
				spec.Labels?.["logistack.spec-hash"]
			)
				await upsertService(ctx, await pullAuth(ctx, row, row.image), spec);
			if (!row.enabled) {
				await setStatus(ctx, row, "disabled", null);
				continue;
			}
			const tasks = await ctx.docker.tasks.list({
				service: [spec.Name],
				"desired-state": ["running"],
			});
			const state = tasks[0]?.Status?.State;
			if (state === "running") await setStatus(ctx, row, "running", null);
			else if (state === "failed" || state === "rejected")
				await setStatus(
					ctx,
					row,
					"error",
					tasks[0]?.Status?.Err ?? `the task is ${state}`,
				);
			else
				await setStatus(
					ctx,
					row,
					"pending",
					state ? `the task is ${state}` : null,
				);
		} catch (e) {
			log("warn", "plugin reconcile failed", {
				installId: row.id,
				error: errMsg(e),
			});
			await setStatus(ctx, row, "error", errMsg(e));
		}
	}
}
