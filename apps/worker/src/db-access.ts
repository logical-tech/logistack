import {
	compileDbGateway,
	DB_TLS_FILES,
	gatewayName,
	orgDbNetworkName,
} from "@logistack/core";
import { databaseAccess, deployment, service } from "@logistack/db";
import {
	LABEL_KIND,
	LABEL_MANAGED,
	LABEL_RESOURCE,
	type ServiceSpec,
} from "@logistack/docker";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { ensureOrgDbNetwork, inspectService, upsertService } from "./apply.ts";
import { log } from "./bus.ts";
import { caddyStorageKey, openFile, type StoredFile } from "./caddy-storage.ts";
import { CADDY_PREFIX, covers, describePem } from "./certs.ts";
import { type Ctx, scope } from "./ctx.ts";
import { svcName } from "./load.ts";
import { enqueueDeploy } from "./queues.ts";

// Public access and port forwards of databases (docs/plans/database-ops.md): the certificate
// the database serves, and one gateway service per `database_access` row.

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type CertPair = { certPem: string; keyPem: string; notAfter: Date };

/**
 * The newest certificate in Caddy's storage that covers `hostname` (its own, or a wildcard),
 * with its key. Caddy issues it because the proxy sync lists the name under `automate`.
 */
export async function caddyCertPair(
	ctx: Ctx,
	hostname: string,
): Promise<CertPair | undefined> {
	const redis = ctx.bus.redis;
	const key = await caddyStorageKey(ctx);
	const read = async (name: string) => {
		const raw = await redis.get(name);
		if (!raw) return undefined;
		return new TextDecoder().decode(
			await openFile(JSON.parse(raw) as StoredFile, key),
		);
	};
	let best: CertPair | undefined;
	let cursor = "0";
	do {
		const [next, batch] = (await redis.send("SCAN", [
			cursor,
			"MATCH",
			`${CADDY_PREFIX}/certificates/*.crt`,
			"COUNT",
			"1000",
		])) as [string, string[]];
		cursor = next;
		for (const name of batch) {
			try {
				const certPem = await read(name);
				if (!certPem) continue;
				const cert = describePem(certPem);
				const notAfter = new Date(cert.notAfter);
				if (!cert.names.some((n) => covers(n, hostname))) continue;
				if (notAfter <= new Date() || (best && notAfter <= best.notAfter))
					continue;
				const keyPem = await read(name.replace(/\.crt$/, ".key"));
				if (keyPem) best = { certPem, keyPem, notAfter };
			} catch {
				log("warn", "unreadable certificate in caddy storage", { key: name });
			}
		}
	} while (cursor !== "0");
	return best;
}

/**
 * The certificate a database serves for its public access, when it has one and Caddy has issued
 * it. Records which certificate went into the spec, so a renewal can roll the database.
 */
export async function databaseTls(
	ctx: Ctx,
	serviceId: string,
): Promise<CertPair | undefined> {
	const [row] = await ctx.db
		.select()
		.from(databaseAccess)
		.where(
			and(
				eq(databaseAccess.serviceId, serviceId),
				eq(databaseAccess.kind, "public"),
				isNotNull(databaseAccess.hostname),
			),
		);
	if (!row?.hostname) return undefined;
	const pair = await caddyCertPair(ctx, row.hostname);
	await ctx.db
		.update(databaseAccess)
		.set(
			pair
				? { certNotAfter: pair.notAfter }
				: {
						status: "waiting_certificate",
						statusMessage: `waiting for a certificate for ${row.hostname}`,
					},
		)
		.where(eq(databaseAccess.id, row.id));
	return pair;
}

/** Queues a deployment of the database without waiting; the deploy job picks up the new certificate. */
async function redeploy(ctx: Ctx, serviceId: string) {
	await ctx.db.insert(deployment).values({ serviceId, trigger: "api" });
	await enqueueDeploy(ctx.queues, serviceId);
}

/**
 * Rolls databases whose public certificate is missing from their spec or has been renewed.
 * Runs in the certificates pass and whenever a row waits for its first certificate.
 */
export async function rollRenewedCertificates(ctx: Ctx, onlyWaiting = false) {
	const rows = await ctx.db
		.select()
		.from(databaseAccess)
		.where(
			and(
				eq(databaseAccess.kind, "public"),
				isNotNull(databaseAccess.hostname),
				...(onlyWaiting
					? [eq(databaseAccess.status, "waiting_certificate")]
					: []),
			),
		);
	for (const row of rows) {
		if (!row.hostname) continue;
		const pair = await caddyCertPair(ctx, row.hostname).catch(() => undefined);
		if (!pair) continue;
		if (row.certNotAfter && pair.notAfter <= row.certNotAfter) continue;
		log("info", "rolling a database onto a new certificate", {
			serviceId: row.serviceId,
			hostname: row.hostname,
			notAfter: pair.notAfter.toISOString(),
		});
		await ctx.db
			.update(databaseAccess)
			.set({ status: "pending", statusMessage: "deploying the certificate" })
			.where(eq(databaseAccess.id, row.id));
		await redeploy(ctx, row.serviceId);
	}
}

/** The image gateways run: ours, from config or from the worker's own stack service. */
async function gatewayImage(ctx: Ctx): Promise<string | undefined> {
	if (ctx.cfg.LS_GATEWAY_IMAGE) return ctx.cfg.LS_GATEWAY_IMAGE;
	const self = await inspectService(
		ctx,
		`${ctx.cfg.LS_STACK_NAME}_logistack-worker`,
	);
	// Swarm pins the tag to a digest (`image:tag@sha256:...`); the tag alone is what we deploy.
	return self?.Spec.TaskTemplate.ContainerSpec?.Image?.split("@")[0];
}

const withHash = (spec: ServiceSpec): ServiceSpec => ({
	...spec,
	Labels: {
		...spec.Labels,
		"logistack.spec-hash": Bun.hash(JSON.stringify(spec)).toString(16),
	},
});

type Row = typeof databaseAccess.$inferSelect;

async function setStatus(
	ctx: Ctx,
	row: Row,
	status: Row["status"],
	statusMessage: string | null,
) {
	if (row.status === status && row.statusMessage === statusMessage) return;
	await ctx.db
		.update(databaseAccess)
		.set({ status, statusMessage })
		.where(eq(databaseAccess.id, row.id));
}

/** Why the gateway cannot run yet, or its compiled spec. */
async function gatewaySpec(
	ctx: Ctx,
	row: Row,
	image: string | undefined,
): Promise<{ spec: ServiceSpec } | { wait: string; status: Row["status"] }> {
	const [db] = await ctx.db
		.select({ spec: service.spec })
		.from(service)
		.where(eq(service.id, row.serviceId));
	if (db?.spec.kind !== "database")
		return { wait: "the service is not a database", status: "error" };
	if (!image)
		return {
			wait: "no gateway image: set LS_GATEWAY_IMAGE or run the worker in the LogiStack stack",
			status: "error",
		};
	const live = await inspectService(ctx, svcName(ctx, row.serviceId));
	const pin = live?.Spec.TaskTemplate.Placement?.Constraints?.find((c) =>
		c.startsWith("node.id=="),
	);
	if (!live || !pin)
		return { wait: "the database is not deployed yet", status: "pending" };
	const network = orgDbNetworkName(row.organizationId, ctx.cfg.LS_NAME_PREFIX);
	if (!live.Spec.TaskTemplate.Networks?.some((n) => n.Target === network)) {
		// Network targets are ids once Swarm stores the spec; compare by id too.
		const id = (await ctx.docker.networks.inspect(network).catch(() => null))
			?.Id;
		if (!id || !live.Spec.TaskTemplate.Networks?.some((n) => n.Target === id))
			return {
				wait: "redeploy the database to move it onto its organization's network",
				status: "pending",
			};
	}
	if (row.tlsRequired) {
		const hasTls = (live.Spec.TaskTemplate.ContainerSpec?.Secrets ?? []).some(
			(s) => Object.values(DB_TLS_FILES).includes(s.File?.Name as never),
		);
		if (!hasTls)
			return row.kind === "public"
				? {
						wait: `waiting for a certificate for ${row.hostname}`,
						status: "waiting_certificate",
					}
				: {
						wait: "the database serves no certificate yet",
						status: "pending",
					};
	}
	return {
		spec: withHash(
			compileDbGateway({
				access: row,
				engine: db.spec.engine,
				tlsRequired: row.tlsRequired,
				upstreamHost: svcName(ctx, row.serviceId),
				network: await ensureOrgDbNetwork(ctx, row.organizationId),
				nodeId: pin.slice("node.id==".length),
				image,
				scope: scope(ctx),
			}),
		),
	};
}

/** Gateway services of this install (and only this test scope). */
async function liveGateways(ctx: Ctx) {
	const label = [`${LABEL_MANAGED}=true`, `${LABEL_KIND}=gateway`];
	for (const [k, v] of Object.entries(scope(ctx).labels))
		label.push(`${k}=${v}`);
	return (await ctx.docker.services.list({ label })).filter((s) =>
		s.Spec.Name.startsWith(`${ctx.cfg.LS_NAME_PREFIX}ls-gw-`),
	);
}

/**
 * Converges gateways to `database_access`: expired forwards are deleted, gateways without a row
 * removed, the others created or updated. Idempotent; runs every 30 s and after each change.
 */
export async function reconcileDbAccess(ctx: Ctx, now = new Date()) {
	const expired = await ctx.db
		.delete(databaseAccess)
		.where(
			and(
				isNotNull(databaseAccess.expiresAt),
				lte(databaseAccess.expiresAt, now),
			),
		)
		.returning({ id: databaseAccess.id, serviceId: databaseAccess.serviceId });
	for (const e of expired)
		log("info", "port forward expired", { accessId: e.id, ...e });

	const rows = await ctx.db.select().from(databaseAccess);
	const wanted = new Set(rows.map((r) => r.id));
	for (const s of await liveGateways(ctx)) {
		const id = s.Spec.Labels?.[LABEL_RESOURCE];
		if (id && wanted.has(id)) continue;
		await ctx.docker.services.remove(s.ID).catch(() => {});
		log("info", "removed a database gateway", { name: s.Spec.Name });
	}

	if (rows.some((r) => r.status === "waiting_certificate"))
		await rollRenewedCertificates(ctx, true).catch((e) =>
			log("warn", "certificate check failed", { error: errMsg(e) }),
		);
	const image = rows.length ? await gatewayImage(ctx) : undefined;
	for (const row of rows) {
		try {
			const r = await gatewaySpec(ctx, row, image);
			if ("wait" in r) {
				const live = await inspectService(
					ctx,
					gatewayName(row.id, ctx.cfg.LS_NAME_PREFIX),
				);
				if (live) await ctx.docker.services.remove(live.ID).catch(() => {});
				await setStatus(ctx, row, r.status, r.wait);
				continue;
			}
			const live = await inspectService(ctx, r.spec.Name);
			if (
				live?.Spec.Labels?.["logistack.spec-hash"] !==
				r.spec.Labels?.["logistack.spec-hash"]
			)
				await upsertService(ctx, undefined, r.spec);
			await setStatus(ctx, row, "active", null);
		} catch (e) {
			await setStatus(ctx, row, "error", errMsg(e));
		}
	}
}
