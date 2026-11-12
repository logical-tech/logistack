import { Resolver } from "node:dns/promises";
import { isIPv4 } from "node:net";
import {
	HOME_DNS_DEFAULT_BLOCKLIST,
	HomeDnsSettings,
	type HomeDnsStatus,
	TECHNITIUM_PORT,
} from "@logistack/contracts";
import {
	advanceHomeDns,
	decrypt,
	dockerName,
	encrypt,
	type HomeDnsEvent,
	homeDnsAlert,
} from "@logistack/core";
import {
	homeNetwork,
	instanceSettings,
	node,
	organization,
} from "@logistack/db";
import {
	type Labels,
	managedLabels,
	type ServiceSpec,
} from "@logistack/docker";
import {
	type Fetch,
	isPrivateAddress,
	QUERY_LOG_APP,
	TechnitiumError,
	technitium,
} from "@logistack/providers";
import { eq } from "drizzle-orm";
import { inspectService, notFound, upsertService } from "./apply.ts";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";

/** On every object this module creates; cleanup lists by it and nothing else. */
export const HOME_DNS_LABEL = "logistack.home-dns";
/** Set on a node by `install.sh --enable-dns`: a request to turn the DNS on there with defaults. */
export const HOME_DNS_REQUEST_LABEL = "logistack.dns";
const TOKEN_NAME = "logistack";
const DATA_DIR = "/etc/dns";
const INSTALL_TIMEOUT_MS = 30 * 60_000;
/** How long `starting` may wait for the API before the pass reports an error. */
const START_GRACE_MS = 5 * 60_000;

export type HomeDnsDeps = {
	/** Technitium's API base URL for a node address; default `http://<address>:5380`. */
	url?: (nodeAddress: string) => string;
	fetch?: Fetch;
	/** Throws unless a real DNS query to `address:53` is answered by Technitium. */
	probe?: (address: string, zone: string | null) => Promise<void>;
};

export const homeDnsNames = (ctx: Pick<Ctx, "cfg">, id: string) => {
	const name = `${ctx.cfg.LS_NAME_PREFIX}${dockerName("hdn", id)}`;
	return { service: name, volume: `${name}-data` };
};

/**
 * Pure: Technitium on the chosen node's host network, so it sees real client addresses and can
 * serve DHCP (NET_ADMIN). The admin password goes through env, read by Technitium on first start.
 */
export function compileHomeDns(i: {
	name: string;
	image: string;
	volume: string;
	swarmNodeId: string;
	adminPassword: string;
	labels: Labels;
}): ServiceSpec {
	const spec: ServiceSpec = {
		Name: i.name,
		Labels: i.labels,
		TaskTemplate: {
			ContainerSpec: {
				Image: i.image,
				Labels: i.labels,
				Env: [
					"DNS_SERVER_DOMAIN=logistack-dns",
					`DNS_SERVER_ADMIN_PASSWORD=${i.adminPassword}`,
				],
				Mounts: [
					{
						Type: "volume",
						Source: i.volume,
						Target: DATA_DIR,
						VolumeOptions: { Labels: i.labels },
					},
				],
				CapabilityAdd: ["NET_ADMIN"],
			},
			RestartPolicy: { Condition: "any", Delay: 5e9 },
			Placement: { Constraints: [`node.id==${i.swarmNodeId}`] },
			Networks: [{ Target: "host" }],
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

export const settingsHash = (s: HomeDnsSettings) =>
	Bun.hash(JSON.stringify(s)).toString(16);

/**
 * Converges the home DNS to its `home_network` row: the Technitium service, then, through its
 * API, the token, settings, local zone and query log extension, then a real query on port 53.
 * Idempotent; the worker runs it on every proxy sync.
 */
export async function syncHomeDns(
	ctx: Ctx,
	deps: HomeDnsDeps = {},
): Promise<void> {
	const [row] = await adoptRequest(ctx);
	const filters = {
		label: [
			`${HOME_DNS_LABEL}=true`,
			...Object.entries(scope(ctx).labels).map(([k, v]) => `${k}=${v}`),
		],
	};
	const running = await ctx.docker.services.list(filters);
	const wanted =
		row?.desiredState === "running"
			? homeDnsNames(ctx, row.id).service
			: undefined;
	for (const s of running)
		if (s.Spec.Name !== wanted) {
			await ctx.docker.services.remove(s.ID);
			log("info", "home dns service removed", { name: s.Spec.Name });
		}
	if (!row) return;

	if (row.desiredState === "removed") {
		// The task may still hold the volume; the next pass retries until it can go.
		if (running.length) return;
		// shortcut: removes the volume through this worker's engine only; on another node it is "not found" here and stays, fix with an agent volume-remove op when multi-node homes appear.
		try {
			await ctx.docker.volumes.remove(homeDnsNames(ctx, row.id).volume);
		} catch (e) {
			if (!notFound(e)) {
				log("warn", "home dns volume removal failed", { error: String(e) });
				return;
			}
		}
		await ctx.db.delete(homeNetwork).where(eq(homeNetwork.id, row.id));
		log("info", "home dns removed with its data");
		return;
	}

	let status: HomeDnsStatus = row.status;
	const step = (e: HomeDnsEvent) => {
		status = advanceHomeDns(status, e);
	};
	let message: string | null = null;
	const patch: Partial<typeof homeNetwork.$inferInsert> = {};
	const [n] = await ctx.db.select().from(node).where(eq(node.id, row.nodeId));

	if (row.desiredState === "stopped" || !n) {
		step("stop");
		patch.serviceId = null;
	} else
		try {
			const adminPassword = await decrypt(
				ctx.masterKey,
				row.adminPasswordEncrypted,
			);
			const names = homeDnsNames(ctx, row.id);
			const deployed = await converge(
				ctx,
				compileHomeDns({
					name: names.service,
					image: ctx.cfg.LS_TECHNITIUM_IMAGE,
					volume: names.volume,
					swarmNodeId: n.swarmNodeId,
					adminPassword,
					labels: {
						...managedLabels({
							resource: row.id,
							kind: "system",
							org: "system",
						}),
						[HOME_DNS_LABEL]: "true",
						...scope(ctx).labels,
					},
				}),
			);
			patch.serviceId = deployed.id ?? null;
			if (deployed.changed) step("deployed");

			const url = (deps.url ?? defaultUrl)(n.address);
			const http = { fetch: deps.fetch };
			try {
				await technitium(url, undefined, http).ping();
			} catch (e) {
				if (
					status === "starting" &&
					Date.now() - row.updatedAt.getTime() < START_GRACE_MS
				) {
					message = "Waiting for Technitium to start";
					throw new Waiting();
				}
				throw new Error(
					`Technitium's API does not answer at ${url}: ${errorText(e)}`,
				);
			}
			step("api_up");

			const stored = row.tokenEncrypted
				? await decrypt(ctx.masterKey, row.tokenEncrypted)
				: undefined;
			let api = technitium(url, stored, http);
			let version = stored
				? await api.version().catch((e: unknown) => {
						// A new volume (the node moved) knows nothing of the old token.
						if (e instanceof TechnitiumError && e.invalidToken)
							return undefined;
						throw e;
					})
				: undefined;
			let appliedHash = row.appliedHash;
			if (version === undefined) {
				const session = await technitium(url, undefined, http).login(
					"admin",
					adminPassword,
				);
				const token = await technitium(url, session, http).createToken(
					TOKEN_NAME,
				);
				patch.tokenEncrypted = await encrypt(ctx.masterKey, token);
				appliedHash = null;
				api = technitium(url, token, http);
				version = await api.version();
			}
			patch.version = version;

			const hash = settingsHash(row.settings);
			if (appliedHash !== hash) {
				await api.applySettings(row.settings);
				log("info", "home dns settings applied");
			}
			patch.appliedHash = hash;

			const zone = row.settings.localZone;
			if (zone && !(await api.zones()).some((z) => z.name === zone))
				await api.createZone(zone);

			const [instance] = await ctx.db
				.select({ wildcard: instanceSettings.customWildcard })
				.from(instanceSettings);
			const base = instance?.wildcard?.slice(2);
			if (base && isPrivateAddress(row.lanAddress))
				await ensureSplitHorizon(api, base, row.lanAddress);

			message = await ensureQueryLogApp(row.id, api);

			try {
				await (deps.probe ?? probePort53)(row.lanAddress, zone);
			} catch (e) {
				throw new Error(
					`Technitium's API answers but port 53 on ${row.lanAddress} does not (${errorText(e)}). Another resolver probably holds port 53 on ${n.hostname}: run install.sh --enable-dns there.`,
				);
			}
			step("configured");
		} catch (e) {
			if (!(e instanceof Waiting)) {
				message = errorText(e);
				step("fail");
				log("warn", "home dns sync failed", { error: message });
			}
		}

	const alert = homeDnsAlert(row.status, status);
	if (alert)
		for (const org of await ctx.db
			.select({ id: organization.id })
			.from(organization))
			await ctx.bus.publish(
				"network.dns.unhealthy",
				org.id,
				{ type: "home_network", id: row.id },
				{
					state: alert,
					name: n ? `Home DNS on ${n.hostname}` : "Home DNS",
					...(n ? { node: n.hostname } : {}),
					...(message ? { message } : {}),
				},
			);

	const next = { ...patch, status, statusMessage: message };
	const changed = Object.entries(next).some(
		([k, v]) => row[k as keyof typeof row] !== v,
	);
	if (changed)
		await ctx.db
			.update(homeNetwork)
			.set(next)
			.where(eq(homeNetwork.id, row.id));
}

/**
 * `install.sh --enable-dns` runs before anyone can sign in, so it leaves a node label instead of
 * calling the API. With no home DNS yet, the labelled node gets one with defaults; the label is
 * then removed, so turning the DNS off later is not undone by the next pass.
 */
async function adoptRequest(ctx: Ctx) {
	const rows = await ctx.db.select().from(homeNetwork);
	const labelled = await ctx.docker.nodes.list({
		"node.label": [`${HOME_DNS_REQUEST_LABEL}=true`],
	});
	const [dn] = labelled;
	if (!dn) return rows;
	if (!rows.length) {
		const [n] = await ctx.db
			.select()
			.from(node)
			.where(eq(node.swarmNodeId, dn.ID));
		// The node sync has not recorded this node yet; the next pass adopts it.
		if (!n) return rows;
		if (!isIPv4(n.address)) {
			log("warn", "home dns request ignored: the node address is not IPv4", {
				node: n.hostname,
			});
		} else {
			const password = crypto
				.getRandomValues(new Uint8Array(24))
				.toBase64({ alphabet: "base64url", omitPadding: true });
			rows.push(
				...(await ctx.db
					.insert(homeNetwork)
					.values({
						nodeId: n.id,
						lanAddress: n.address,
						settings: HomeDnsSettings.parse({
							blocking: {
								enabled: true,
								listUrls: [HOME_DNS_DEFAULT_BLOCKLIST],
							},
						}),
						adminPasswordEncrypted: await encrypt(ctx.masterKey, password),
					})
					.onConflictDoNothing()
					.returning()),
			);
			log("info", "home dns turned on from the installer's request", {
				node: n.hostname,
			});
		}
	}
	for (const l of labelled) {
		const { [HOME_DNS_REQUEST_LABEL]: _, ...Labels } = l.Spec.Labels ?? {};
		await ctx.docker.nodes.update(l.ID, l.Version.Index, { ...l.Spec, Labels });
	}
	return rows;
}

type RecordKey = { name: string; type: string; content: string };

/**
 * Pure: what makes the base and its subdomains answer with the node's LAN address inside the
 * house, so the dashboard opens on the LAN even when the public records point at the router.
 * Other A records for those names (an older address) go, so clients never get both.
 */
export function splitHorizonPlan<R extends RecordKey>(
	existing: R[],
	base: string,
	lanAddress: string,
) {
	const names = [`*.${base}`, base];
	const isOurs = (r: RecordKey) => r.type === "A" && names.includes(r.name);
	return {
		add: names
			.filter(
				(name) =>
					!existing.some(
						(e) => isOurs(e) && e.name === name && e.content === lanAddress,
					),
			)
			.map((name) => ({
				name,
				type: "A" as const,
				content: lanAddress,
				ttl: 300,
				comment: "LogiStack: the instance's base on the LAN",
			})),
		remove: existing.filter((e) => isOurs(e) && e.content !== lanAddress),
	};
}

/** A Forwarder zone, not a Primary one: names under the base without a record here still resolve publicly. */
// shortcut: the home DNS node's address stands for Caddy's; with ingress on other nodes, point the records there.
async function ensureSplitHorizon(
	api: ReturnType<typeof technitium>,
	base: string,
	lanAddress: string,
) {
	if (!(await api.zones()).some((z) => z.name === base))
		await api.createForwarderZone(base);
	const plan = splitHorizonPlan(await api.records(base), base, lanAddress);
	for (const r of plan.remove) await api.deleteRecord(base, r);
	for (const r of plan.add) await api.addRecord(base, r);
}

class Waiting extends Error {}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const defaultUrl = (address: string) =>
	`http://${address.includes(":") ? `[${address}]` : address}:${TECHNITIUM_PORT}`;

// shortcut: in-process, so two worker replicas could both start the download; Technitium refuses the second install, upgrade to a Redis lock if that log line shows up.
const installs = new Map<string, { running?: Promise<void>; error?: string }>();

/**
 * The query log extension is a download of many megabytes from Technitium's site, so it installs
 * in the background; the pass reports progress through the status message and never waits.
 */
async function ensureQueryLogApp(
	rowId: string,
	api: ReturnType<typeof technitium>,
): Promise<string | null> {
	if ((await api.apps()).some((a) => a.name === QUERY_LOG_APP.name)) {
		installs.delete(rowId);
		return null;
	}
	const state = installs.get(rowId) ?? {};
	installs.set(rowId, state);
	if (state.running)
		return "Installing the query log extension; the download can take several minutes";
	const previous = state.error;
	try {
		const app = (await api.storeApps()).find(
			(a) => a.name === QUERY_LOG_APP.name,
		);
		if (!app) throw new Error("it is not in Technitium's app store");
		state.running = api
			.installApp(app.name, app.url, INSTALL_TIMEOUT_MS)
			.then(
				() => {
					state.error = undefined;
				},
				(e: unknown) => {
					state.error = errorText(e);
				},
			)
			.finally(() => {
				state.running = undefined;
			});
	} catch (e) {
		state.error = errorText(e);
	}
	const failed = state.error ?? previous;
	return failed
		? `The query log extension did not install (${failed}); retrying`
		: "Installing the query log extension; the download can take several minutes";
}

/** Any answer proves the port is served; with a local zone, its SOA proves the answer is Technitium's. */
async function probePort53(address: string, zone: string | null) {
	const r = new Resolver({ timeout: 3_000, tries: 2 });
	r.setServers([address]);
	if (zone) {
		await r.resolveSoa(zone);
		return;
	}
	try {
		await r.resolve4("localhost");
	} catch (e) {
		const code = (e as { code?: string }).code;
		if (code !== "ENOTFOUND" && code !== "ENODATA") throw e;
	}
}

/** Creates or updates `spec` when its hash changed. */
async function converge(ctx: Ctx, spec: ServiceSpec) {
	const hash = spec.Labels?.["logistack.spec-hash"];
	const current = await inspectService(ctx, spec.Name);
	if (current && current.Spec.Labels?.["logistack.spec-hash"] === hash)
		return { id: current.ID, changed: false };
	await upsertService(ctx, undefined, spec);
	log(
		"info",
		current ? "home dns service updated" : "home dns service created",
		{
			name: spec.Name,
		},
	);
	return { id: (await inspectService(ctx, spec.Name))?.ID, changed: true };
}
