import { decrypt } from "@logistack/core";
import { instanceSettings, registry } from "@logistack/db";
import {
	DockerError,
	type Labels,
	managedLabels,
	type ServiceSpec,
} from "@logistack/docker";
import { sha256Hex } from "@logistack/providers";
import { eq } from "drizzle-orm";
import { inspectService, upsertService } from "./apply.ts";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";

export const ZOT_PORT = 5000;

export const localRegistryName = (ctx: Ctx) =>
	`${ctx.cfg.LS_NAME_PREFIX}ls-registry`;
const volumeName = (ctx: Ctx) => `${localRegistryName(ctx)}-data`;

/** Zot with htpasswd auth (every authenticated user may push, pull and delete) and scheduled GC. */
export const ZOT_CONFIG = JSON.stringify({
	distSpecVersion: "1.1.1",
	storage: {
		rootDirectory: "/var/lib/registry",
		gc: true,
		gcDelay: "1h",
		gcInterval: "6h",
	},
	http: {
		address: "0.0.0.0",
		port: String(ZOT_PORT),
		auth: { htpasswd: { path: "/etc/zot/htpasswd" } },
	},
	log: { level: "info" },
});

export type LocalRegistryInput = {
	name: string;
	image: string;
	labels: Labels;
	config: { id: string; name: string };
	htpasswd: { id: string; name: string };
	network: string;
	volume: string;
	constraints: string[];
	/** Host port for loopback pushes (single node without DNS, tests); 0 publishes nothing. */
	publishPort: number;
};

/** Pure: the Swarm service running Zot. Its hash label lets the reconciler skip no-op updates. */
export function compileLocalRegistry(i: LocalRegistryInput): ServiceSpec {
	const file = (name: string) => ({
		Name: name,
		UID: "0",
		GID: "0",
		Mode: 0o444,
	});
	const spec: ServiceSpec = {
		Name: i.name,
		Labels: i.labels,
		TaskTemplate: {
			ContainerSpec: {
				Image: i.image,
				Labels: i.labels,
				Args: ["serve", "/etc/zot/config.json"],
				Configs: [
					{
						ConfigID: i.config.id,
						ConfigName: i.config.name,
						File: file("/etc/zot/config.json"),
					},
				],
				Secrets: [
					{
						SecretID: i.htpasswd.id,
						SecretName: i.htpasswd.name,
						File: file("/etc/zot/htpasswd"),
					},
				],
				Mounts: [
					{
						Type: "volume",
						Source: i.volume,
						Target: "/var/lib/registry",
						VolumeOptions: { Labels: i.labels },
					},
				],
			},
			RestartPolicy: { Condition: "any", Delay: 5e9 },
			Placement: { Constraints: i.constraints },
			Networks: [{ Target: i.network, Aliases: [i.name] }],
		},
		Mode: { Replicated: { Replicas: 1 } },
		...(i.publishPort
			? {
					EndpointSpec: {
						Ports: [
							{
								Protocol: "tcp",
								TargetPort: ZOT_PORT,
								PublishedPort: i.publishPort,
								PublishMode: "ingress",
							},
						],
					},
				}
			: {}),
	};
	return {
		...spec,
		Labels: {
			...i.labels,
			"logistack.spec-hash": Bun.hash(JSON.stringify(spec)).toString(16),
		},
	};
}

/** Creates a config or secret by exact name unless it exists; content is fixed by the name. */
async function ensureFile(
	ctx: Ctx,
	kind: "config" | "secret",
	name: string,
	data: () => Promise<string>,
	labels: Labels,
): Promise<{ id: string; name: string }> {
	const api = kind === "config" ? ctx.docker.configs : ctx.docker.secrets;
	const find = async () =>
		(await api.list({ name: [name] })).find((o) => o.Spec.Name === name);
	const found = await find();
	if (found) return { id: found.ID, name };
	try {
		const created = await api.create({
			Name: name,
			Labels: labels,
			Data: await data(),
		});
		return { id: created.ID, name };
	} catch (e) {
		const raced = await find();
		if (raced) return { id: raced.ID, name };
		throw e;
	}
}

export type LocalRegistryOutcome = "running" | "stopped" | "purged" | "absent";

/**
 * Converges the managed Zot to Postgres: on while the instance flag is set and some organization
 * has a local registry row; off otherwise. With no local row left the images volume goes too.
 */
export async function syncLocalRegistry(
	ctx: Ctx,
): Promise<LocalRegistryOutcome> {
	const [settings] = await ctx.db.select().from(instanceSettings);
	const locals = await ctx.db
		.select()
		.from(registry)
		.where(eq(registry.kind, "local"));
	const name = localRegistryName(ctx);
	const labels = {
		...managedLabels({ resource: "registry", kind: "system", org: "system" }),
		...scope(ctx).labels,
	};
	const current = await inspectService(ctx, name);

	if (!settings?.localRegistryEnabled || !locals.length) {
		if (current) {
			await ctx.docker.services.remove(current.ID);
			log("info", "local registry stopped", { name });
		}
		if (locals.length) return "stopped";
		const volumes = await ctx.docker.volumes.list({ name: [volumeName(ctx)] });
		if (!volumes.some((v) => v.Name === volumeName(ctx))) return "absent";
		// The task may still be shutting down and hold the volume.
		for (let i = 0; i < 30; i++)
			try {
				await ctx.docker.volumes.remove(volumeName(ctx));
				log("warn", "local registry images purged", {
					volume: volumeName(ctx),
				});
				return "purged";
			} catch (e) {
				if (!(e instanceof DockerError) || !e.conflict) throw e;
				await Bun.sleep(1_000);
			}
		throw new Error(`volume ${volumeName(ctx)} is still in use`);
	}

	const users = await Promise.all(
		locals.map(async (r) => ({
			username: r.username ?? "logistack",
			password: r.passwordEncrypted
				? await decrypt(ctx.masterKey, r.passwordEncrypted)
				: "",
		})),
	);
	const usersHash = (await sha256Hex(JSON.stringify(users))).slice(0, 12);
	const htpasswd = await ensureFile(
		ctx,
		"secret",
		`${name}-htpasswd-${usersHash}`,
		async () =>
			(
				await Promise.all(
					users.map(
						async (u) =>
							`${u.username}:${await Bun.password.hash(u.password, { algorithm: "bcrypt", cost: 10 })}`,
					),
				)
			).join("\n"),
		labels,
	);
	const config = await ensureFile(
		ctx,
		"config",
		`${name}-config-${(await sha256Hex(ZOT_CONFIG)).slice(0, 12)}`,
		async () => ZOT_CONFIG,
		labels,
	);
	const spec = compileLocalRegistry({
		name,
		image: ctx.cfg.LS_ZOT_IMAGE,
		labels,
		config,
		htpasswd,
		network: ctx.cfg.LS_INGRESS_NETWORK,
		volume: volumeName(ctx),
		// The volume is node-local: once placed, the registry stays on that node.
		constraints: current?.Spec.TaskTemplate.Placement?.Constraints ?? [
			`node.id==${(await ctx.docker.info()).Swarm.NodeID}`,
		],
		publishPort: ctx.cfg.LS_LOCAL_REGISTRY_PORT,
	});
	if (
		current?.Spec.Labels?.["logistack.spec-hash"] ===
		spec.Labels?.["logistack.spec-hash"]
	)
		return "running";
	await upsertService(ctx, undefined, spec);
	log("info", current ? "local registry updated" : "local registry created", {
		name,
	});
	return "running";
}
