import { decrypt, storageEngineDefs } from "@logistack/core";
import { instanceSettings, node, s3Destination, service } from "@logistack/db";
import { LABEL_KIND, LABEL_ORG, LABEL_RESOURCE } from "@logistack/docker";
import {
	type BackupDestination,
	instantiate,
	pinnedFetch,
	rcloneDestination,
	resolvePublic,
	s3Destination as s3Provider,
} from "@logistack/providers";
import { eq } from "drizzle-orm";
import type { Ctx } from "./ctx.ts";
import {
	isRcloneKind,
	type LocalEnv,
	localDestination,
	localSettings,
	rcloneConfig,
	rcloneHost,
} from "./destinations.ts";
import { svcName } from "./load.ts";
import { hostPolicy, publicAddress } from "./ssrf.ts";

type Row = typeof s3Destination.$inferSelect;

async function allowPrivate(ctx: Ctx) {
	const [s] = await ctx.db
		.select({ allow: instanceSettings.allowPrivateHosts })
		.from(instanceSettings);
	return s?.allow ?? false;
}

/** The destination with its secrets decrypted; any user-chosen host must pass the SSRF policy. */
export async function openDestination(
	ctx: Ctx,
	id: string,
	helper?: LocalEnv["helper"],
): Promise<BackupDestination> {
	const [d] = await ctx.db
		.select()
		.from(s3Destination)
		.where(eq(s3Destination.id, id));
	if (!d) throw new Error(`backup destination ${id} is gone`);
	if (d.kind === "s3") return openS3(ctx, d);
	if (d.kind === "local") {
		if (!d.nodeId)
			throw new Error(`backup destination ${d.name}: its node was removed`);
		const [n] = await ctx.db
			.select({ swarm: node.swarmNodeId })
			.from(node)
			.where(eq(node.id, d.nodeId));
		if (!n) throw new Error(`backup destination ${d.name}: its node is gone`);
		return localDestination({
			nodes: ctx.nodes,
			swarmNodeId: n.swarm,
			path: localSettings.parse(d.config).path,
			image: ctx.cfg.LS_BACKUP_TOOLS_IMAGE,
			jobName: () =>
				`${ctx.cfg.LS_NAME_PREFIX}ls-dst-${crypto.randomUUID().slice(0, 12)}`,
			labels: {
				[LABEL_RESOURCE]: d.id,
				[LABEL_KIND]: "backup-destination",
				[LABEL_ORG]: d.organizationId,
				...ctx.cfg.LS_SCOPE_LABELS,
			},
			helper,
		});
	}
	if (!isRcloneKind(d.kind))
		throw new Error(`backup destination ${d.name}: unknown kind ${d.kind}`);
	const config = rcloneConfig(
		d.kind,
		d.config,
		JSON.parse(await decrypt(ctx.masterKey, d.secretEncrypted)),
	);
	const dial = rcloneHost(config);
	if (dial) {
		if (dial.plain && !(await allowPrivate(ctx)))
			throw new Error("only https WebDAV servers are allowed");
		await publicAddress(ctx, dial.host);
	}
	return rcloneDestination(config);
}

async function openS3(ctx: Ctx, d: Row): Promise<BackupDestination> {
	const config = {
		endpoint: d.endpoint,
		region: d.region,
		bucket: d.bucket,
		prefix: d.prefix,
		accessKeyId: d.accessKeyId,
		secretAccessKey: await decrypt(ctx.masterKey, d.secretEncrypted),
		forcePathStyle: d.forcePathStyle,
	};
	// A LogiStack storage service: the endpoint is derived from its id on the storage network, never read from the row.
	if (d.storageServiceId) {
		const [svc] = await ctx.db
			.select({ spec: service.spec })
			.from(service)
			.where(eq(service.id, d.storageServiceId));
		if (svc?.spec.kind !== "storage")
			throw new Error(`S3 destination ${d.id}: its storage service is gone`);
		const port = storageEngineDefs[svc.spec.engine].s3Port;
		return instantiate(s3Provider, {
			...config,
			endpoint: `http://${svcName(ctx, d.storageServiceId)}:${port}`,
			forcePathStyle: true,
		});
	}
	const url = new URL(d.endpoint);
	if (url.protocol !== "https:" && !(await allowPrivate(ctx)))
		throw new Error("only https S3 endpoints are allowed");
	const policy = await hostPolicy(ctx.db);
	await resolvePublic(url.hostname, policy);
	// Each request re-checks and pins its address, so a rebinding DNS answer is never dialled.
	return instantiate(s3Provider, config, {
		fetch: pinnedFetch(policy, { privateHttp: true }),
	});
}
