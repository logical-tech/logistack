import { type ScanJob, TrivyReport } from "@logistack/contracts";
import { decrypt, newCriticals, parseTrivyReport } from "@logistack/core";
import {
	environment,
	imageScan,
	imageVulnerability,
	project,
	registry,
	service,
	serviceImage,
} from "@logistack/db";
import {
	authForImage,
	LABEL_RESOURCE,
	managedLabels,
	type RegistryAuth,
} from "@logistack/docker";
import { and, eq, gt, inArray, notInArray } from "drizzle-orm";
import { log, withLock } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import { svcName } from "./load.ts";

/** Trivy's default cache dir in its image; the volume keeps the vulnerability DB between scans. */
const CACHE_DIR = "/root/.cache/trivy";
const SCAN_TIMEOUT_MS = 15 * 60_000;
/** A deploy whose digest was scanned this recently reuses that result. */
const FRESH_MS = 12 * 3_600_000;

export type ImageInUse = {
	serviceId: string;
	organizationId: string;
	/** Reference without the digest, as the user knows it. */
	image: string;
	/** `sha256:…`: the registry digest, or the local image id when the image has none. */
	digest: string;
	/** Built here and never pushed: Trivy reads it from the engine instead of a registry. */
	local: boolean;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Scans run one container at a time per worker; the name prefix is ours alone. */
const containerPrefix = (ctx: Ctx) => `${ctx.cfg.LS_NAME_PREFIX}ls-vulnscan-`;

/**
 * Runs `trivy image` in a one-off container and returns its JSON report. Registry credentials
 * go through env; a local image is read through the engine socket, a pushed one from its registry.
 */
export async function runTrivy(
	ctx: Ctx,
	o: { ref: string; local: boolean; auth?: RegistryAuth; orgId: string },
): Promise<TrivyReport> {
	const image = ctx.cfg.LS_TRIVY_IMAGE;
	await ctx.docker.images
		.inspect(image)
		.catch(() => ctx.docker.images.pull(image));
	const labels = {
		...managedLabels({ resource: "vulnscan", kind: "system", org: o.orgId }),
		...ctx.cfg.LS_SCOPE_LABELS,
	};
	const cache = `${ctx.cfg.LS_NAME_PREFIX}ls-trivy-cache`;
	await ctx.docker.volumes.create({
		Name: cache,
		Labels: {
			...managedLabels({
				resource: "trivy-cache",
				kind: "system",
				org: "system",
			}),
			...ctx.cfg.LS_SCOPE_LABELS,
		},
	});
	const env: string[] = [];
	if (o.auth?.username && o.auth.password)
		env.push(
			`TRIVY_USERNAME=${o.auth.username}`,
			`TRIVY_PASSWORD=${o.auth.password}`,
		);
	const name = `${containerPrefix(ctx)}${crypto.randomUUID().slice(0, 12)}`;
	const { Id } = await ctx.docker.containers.create(name, {
		Image: image,
		Cmd: [
			"image",
			"--format",
			"json",
			"--scanners",
			"vuln",
			"--quiet",
			"--timeout",
			`${SCAN_TIMEOUT_MS / 60_000}m`,
			"--image-src",
			o.local ? "docker" : "remote",
			o.ref,
		],
		Env: env,
		Labels: labels,
		HostConfig: {
			Mounts: [
				{ Type: "volume", Source: cache, Target: CACHE_DIR },
				...(o.local
					? [
							{
								Type: "bind" as const,
								Source: "/var/run/docker.sock",
								Target: "/var/run/docker.sock",
								ReadOnly: true,
							},
						]
					: []),
			],
			// The engine's own view of registries: `localhost:<port>` is the node, as for its pulls.
			NetworkMode: "host",
		},
	});
	try {
		await ctx.docker.containers.start(Id);
		const deadline = Date.now() + SCAN_TIMEOUT_MS + 60_000;
		let exit: number | undefined;
		while (exit === undefined) {
			const s = (await ctx.docker.containers.inspect(Id)).State;
			if (s.Status === "exited" || s.Status === "dead") exit = s.ExitCode;
			else if (Date.now() > deadline) throw new Error("scan timed out");
			else await Bun.sleep(1_000);
		}
		const dec = new TextDecoder();
		let out = "";
		let err = "";
		for await (const f of await ctx.docker.containers.logs(Id)) {
			if (f.stream === "stderr") err += dec.decode(f.data);
			else out += dec.decode(f.data);
		}
		if (exit !== 0)
			throw new Error(
				`trivy exited ${exit}: ${err.trim().split("\n").slice(-5).join("\n")}`,
			);
		return TrivyReport.parse(JSON.parse(out));
	} finally {
		await ctx.docker.containers.remove(Id, true).catch(() => {});
	}
}

/** Images of the managed Swarm services (one, or all), with their digest. */
async function imagesInUse(
	ctx: Ctx,
	serviceId?: string,
): Promise<ImageInUse[]> {
	const label = [`logistack.managed=true`];
	for (const [k, v] of Object.entries(ctx.cfg.LS_SCOPE_LABELS))
		label.push(`${k}=${v}`);
	const specs = serviceId
		? await ctx.docker.services
				.inspect(svcName(ctx, serviceId))
				.then((s) => [s])
				.catch(() => [])
		: await ctx.docker.services.list({ label });
	const byId = new Map<string, string>();
	for (const s of specs) {
		const id = s.Spec.Labels?.[LABEL_RESOURCE];
		const img = s.Spec.TaskTemplate.ContainerSpec?.Image;
		if (id && img) byId.set(id, img);
	}
	if (!byId.size) return [];
	const rows = await ctx.db
		.select({ id: service.id, organizationId: project.organizationId })
		.from(service)
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(inArray(service.id, [...byId.keys()]));
	const out: ImageInUse[] = [];
	for (const r of rows) {
		const ref = byId.get(r.id) as string;
		const at = ref.indexOf("@");
		if (at > 0) {
			out.push({
				serviceId: r.id,
				organizationId: r.organizationId,
				image: ref.slice(0, at),
				digest: ref.slice(at + 1),
				local: false,
			});
			continue;
		}
		// No registry digest: an image built here and never pushed. Its id stands in.
		const local = await ctx.docker.images.inspect(ref).catch(() => undefined);
		if (local)
			out.push({
				serviceId: r.id,
				organizationId: r.organizationId,
				image: ref,
				digest: local.Id,
				local: true,
			});
	}
	return out;
}

async function registryAuth(ctx: Ctx, orgId: string, image: string) {
	const [reg] = await ctx.db
		.select()
		.from(registry)
		.where(
			and(eq(registry.organizationId, orgId), eq(registry.isDefault, true)),
		);
	if (!reg?.username || !reg.passwordEncrypted) return undefined;
	return authForImage(image, {
		username: reg.username,
		password: await decrypt(ctx.masterKey, reg.passwordEncrypted),
		serveraddress: reg.url.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, ""),
	});
}

/** Scans one digest, replaces its findings and announces new critical ones to every service running it. */
export async function scanDigest(ctx: Ctx, t: ImageInUse): Promise<void> {
	const ran = await withLock(
		ctx.bus.redis,
		`ls:lock:vulnscan:${t.digest}`,
		SCAN_TIMEOUT_MS + 120_000,
		async () => {
			await ctx.db
				.insert(imageScan)
				.values({ digest: t.digest, image: t.image, status: "running" })
				.onConflictDoUpdate({
					target: imageScan.digest,
					set: { image: t.image, status: "running", error: null },
				});
			let report: TrivyReport;
			try {
				report = await runTrivy(ctx, {
					ref: t.local ? t.image : `${t.image}@${t.digest}`,
					local: t.local,
					auth: await registryAuth(ctx, t.organizationId, t.image),
					orgId: t.organizationId,
				});
			} catch (e) {
				// Earlier findings stay: a failed rescan must not read as a clean image.
				await ctx.db
					.update(imageScan)
					.set({ status: "failed", error: errMsg(e).slice(0, 2_000) })
					.where(eq(imageScan.digest, t.digest));
				log("warn", "image scan failed", {
					image: t.image,
					digest: t.digest,
					error: errMsg(e),
				});
				return;
			}
			const { findings, counts } = parseTrivyReport(report);
			const fresh = await ctx.db.transaction(async (tx) => {
				const before = await tx
					.select({ id: imageVulnerability.vulnerabilityId })
					.from(imageVulnerability)
					.where(
						and(
							eq(imageVulnerability.digest, t.digest),
							eq(imageVulnerability.severity, "critical"),
						),
					);
				await tx
					.delete(imageVulnerability)
					.where(eq(imageVulnerability.digest, t.digest));
				// Postgres caps a statement at 65k parameters; 8 columns a row.
				for (let i = 0; i < findings.length; i += 1_000)
					await tx.insert(imageVulnerability).values(
						findings.slice(i, i + 1_000).map((f) => ({
							digest: t.digest,
							vulnerabilityId: f.id,
							pkgName: f.pkgName,
							installedVersion: f.installedVersion,
							fixedVersion: f.fixedVersion,
							severity: f.severity,
							title: f.title,
							url: f.url,
						})),
					);
				await tx
					.update(imageScan)
					.set({
						status: "succeeded",
						counts,
						error: null,
						scannedAt: new Date(),
					})
					.where(eq(imageScan.digest, t.digest));
				return newCriticals(
					before.map((b) => b.id),
					findings,
				);
			});
			log("info", "image scanned", {
				image: t.image,
				digest: t.digest,
				...counts,
			});
			if (fresh.length) await announce(ctx, t, fresh, counts.critical);
		},
	);
	if (!ran) log("info", "image scan already running", { digest: t.digest });
}

async function announce(
	ctx: Ctx,
	t: ImageInUse,
	fresh: string[],
	critical: number,
) {
	const users = await ctx.db
		.select({
			id: service.id,
			name: service.name,
			environment: environment.name,
			project: project.name,
			organizationId: project.organizationId,
		})
		.from(serviceImage)
		.innerJoin(service, eq(service.id, serviceImage.serviceId))
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(eq(serviceImage.digest, t.digest));
	const shown = fresh.slice(0, 5).join(", ");
	for (const u of users)
		await ctx.bus.publish(
			"image.vulnerable",
			u.organizationId,
			{ type: "service", id: u.id },
			{
				serviceId: u.id,
				service: u.name,
				project: u.project,
				environment: u.environment,
				image: t.image,
				digest: t.digest,
				critical,
				new: fresh,
				message: `${fresh.length} new critical ${fresh.length === 1 ? "vulnerability" : "vulnerabilities"} in ${t.image}: ${shown}${fresh.length > 5 ? ", …" : ""}`,
			},
		);
}

/**
 * A deploy's image, a manual rescan (`force`) or the daily pass over every image in use.
 * The daily pass also forgets services and digests nothing runs anymore.
 */
export async function processScanJob(
	ctx: Ctx,
	job: ScanJob & { force?: boolean },
): Promise<void> {
	const all = "all" in job;
	const targets = await imagesInUse(ctx, all ? undefined : job.serviceId);
	for (const t of targets)
		await ctx.db
			.insert(serviceImage)
			.values({ serviceId: t.serviceId, image: t.image, digest: t.digest })
			.onConflictDoUpdate({
				target: serviceImage.serviceId,
				set: { image: t.image, digest: t.digest },
			});
	if (all) {
		const running = targets.map((t) => t.serviceId);
		await ctx.db
			.delete(serviceImage)
			.where(
				running.length
					? notInArray(serviceImage.serviceId, running)
					: undefined,
			);
		await sweepContainers(ctx);
	}
	const digests = new Map(targets.map((t) => [t.digest, t]));
	if (!digests.size) return;
	// Recently and successfully scanned digests keep their result unless forced.
	const fresh = new Set(
		job.force
			? []
			: (
					await ctx.db
						.select({ digest: imageScan.digest })
						.from(imageScan)
						.where(
							and(
								inArray(imageScan.digest, [...digests.keys()]),
								eq(imageScan.status, "succeeded"),
								gt(imageScan.scannedAt, new Date(Date.now() - FRESH_MS)),
							),
						)
				).map((r) => r.digest),
	);
	for (const [d, t] of digests) if (!fresh.has(d)) await scanDigest(ctx, t);
	if (all)
		await ctx.db
			.delete(imageScan)
			.where(
				notInArray(
					imageScan.digest,
					ctx.db.select({ d: serviceImage.digest }).from(serviceImage),
				),
			);
}

/** Scan containers a dead worker left behind; only our own name prefix. */
async function sweepContainers(ctx: Ctx) {
	const prefix = containerPrefix(ctx);
	const left = await ctx.docker.containers.list(
		{ name: [prefix], label: ["logistack.managed=true"] },
		true,
	);
	for (const c of left)
		if (
			c.Names.some((n) => n.replace(/^\//, "").startsWith(prefix)) &&
			c.State !== "running"
		)
			await ctx.docker.containers.remove(c.Id, true).catch(() => {});
}
