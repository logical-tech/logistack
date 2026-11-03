import { createRoute, z } from "@hono/zod-openapi";
import {
	type BackupJob,
	BackupRetention,
	BackupRunKind,
	BackupTarget,
	dumpOnlyEngines,
	RestoreTarget,
	RunStatus,
} from "@logistack/contracts";
import { newId } from "@logistack/core";
import {
	backupPolicy,
	backupRun,
	deployment,
	envVar,
	mount,
	s3Destination,
	service,
} from "@logistack/db";
import {
	dropPolicySchedulers,
	syncPolicySchedulers,
} from "@logistack/worker/schedulers";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { type Actor, requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Cron, nextRun, Timezone } from "../cron.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import { envelope } from "../events.ts";
import {
	body,
	errors,
	IdParam,
	json,
	router,
	security,
	slugify,
} from "../openapi.ts";
import { runQueues } from "../run-queues.ts";
import {
	byParam,
	check,
	locate,
	type ResolveResource,
	requirePermission,
} from "../scope.ts";

export const BackupRunView = z
	.object({
		id: z.string(),
		policyId: z.string(),
		kind: BackupRunKind,
		status: RunStatus,
		sizeBytes: z.number().nullable(),
		objectKey: z.string().nullable(),
		checksum: z.string().nullable(),
		startedAt: z.string(),
		finishedAt: z.string().nullable(),
		error: z.string().nullable(),
		detail: z.string().nullable(),
		sourceRunId: z.string().nullable(),
		targetServiceId: z.string().nullable(),
		prunedAt: z.string().nullable(),
	})
	.openapi("BackupRun");

export const BackupPolicyView = z
	.object({
		id: z.string(),
		serviceId: z.string(),
		target: BackupTarget,
		/** Volume backups: the id whose volume is read, a mount's or the database service's own. */
		volumeName: z.string().nullable(),
		s3DestinationId: z.string(),
		destinationName: z.string(),
		cron: z.string(),
		timezone: z.string(),
		retention: BackupRetention,
		verifyCron: z.string().nullable(),
		pauseService: z.boolean(),
		enabled: z.boolean(),
		nextRunAt: z.string().nullable(),
		nextVerifyAt: z.string().nullable(),
		lastRun: BackupRunView.nullable(),
		createdAt: z.string(),
	})
	.openapi("BackupPolicy");

const BackupVolume = z.object({
	/** What a volume policy stores in `volumeName`. */
	id: z.string(),
	/** Mount path inside the service. */
	label: z.string(),
	kind: z.enum(["data", "mount"]),
});

const ServiceBackups = z
	.object({
		service: z.object({
			id: z.string(),
			name: z.string(),
			kind: z.string(),
			engine: z.string().nullable(),
			version: z.string().nullable(),
		}),
		volumes: z.array(BackupVolume),
		policies: z.array(BackupPolicyView),
		/** Newest first, every policy of the service. */
		runs: z.array(BackupRunView),
	})
	.openapi("ServiceBackups");

const PolicyFields = z.object({
	s3DestinationId: z.string(),
	cron: Cron,
	timezone: Timezone.default("UTC"),
	retention: BackupRetention.default({ count: 7 }),
	verifyCron: Cron.nullable().default(null),
	pauseService: z.boolean().default(false),
	enabled: z.boolean().default(true),
});

const PolicyInput = PolicyFields.extend({
	target: BackupTarget,
	volumeName: z.string().nullable().default(null),
});

const PolicyPatch = PolicyFields.partial().refine(
	(o) => Object.keys(o).length > 0,
	"nothing to update",
);

type RunRow = typeof backupRun.$inferSelect;
type PolicyRow = typeof backupPolicy.$inferSelect;

const iso = (d: Date | null) => d?.toISOString() ?? null;

const runView = (r: RunRow): z.infer<typeof BackupRunView> => ({
	id: r.id,
	policyId: r.policyId,
	kind: r.kind,
	status: r.status,
	sizeBytes: r.sizeBytes,
	objectKey: r.objectKey,
	checksum: r.checksum,
	startedAt: r.startedAt.toISOString(),
	finishedAt: iso(r.finishedAt),
	error: r.error,
	detail: r.detail,
	sourceRunId: r.sourceRunId,
	targetServiceId: r.targetServiceId,
	prunedAt: iso(r.prunedAt),
});

const policyView = (
	p: PolicyRow,
	destinationName: string,
	lastRun: RunRow | undefined,
): z.infer<typeof BackupPolicyView> => ({
	id: p.id,
	serviceId: p.serviceId,
	target: p.target,
	volumeName: p.volumeName,
	s3DestinationId: p.s3DestinationId,
	destinationName,
	cron: p.cron,
	timezone: p.timezone,
	retention: p.retention,
	verifyCron: p.verifyCron,
	pauseService: p.pauseService,
	enabled: p.enabled,
	nextRunAt: nextRun(p.cron, p.timezone, p.enabled),
	nextVerifyAt: nextRun(p.verifyCron, p.timezone, p.enabled),
	lastRun: lastRun ? runView(lastRun) : null,
	createdAt: p.createdAt.toISOString(),
});

/** Policy or run → the service it belongs to, for the permission check. */
function viaPolicy(from: "policy" | "run"): ResolveResource {
	return async (c, actor) => {
		const { db } = c.var.deps;
		const id = c.req.param("id") ?? "";
		const [row] =
			from === "policy"
				? await db
						.select({ serviceId: backupPolicy.serviceId })
						.from(backupPolicy)
						.where(eq(backupPolicy.id, id))
				: await db
						.select({ serviceId: backupPolicy.serviceId })
						.from(backupRun)
						.innerJoin(backupPolicy, eq(backupPolicy.id, backupRun.policyId))
						.where(eq(backupRun.id, id));
		const what = from === "policy" ? "backup policy" : "backup run";
		if (!row) throw notFound(what);
		return locate(db, actor.organizationId, "service", row.serviceId).catch(
			() => {
				throw notFound(what);
			},
		);
	};
}

async function serviceRow(c: Context<Env>, id: string) {
	return one(
		await c.var.deps.db.select().from(service).where(eq(service.id, id)),
		"service",
	);
}

async function volumesOf(c: Context<Env>, svc: typeof service.$inferSelect) {
	const mounts = await c.var.deps.db
		.select({ id: mount.id, target: mount.target })
		.from(mount)
		.where(and(eq(mount.serviceId, svc.id), eq(mount.kind, "volume")))
		.orderBy(asc(mount.target));
	return [
		...(svc.spec.kind === "database"
			? [
					{
						id: svc.id,
						label: "Database data directory",
						kind: "data" as const,
					},
				]
			: []),
		...mounts.map((m) => ({
			id: m.id,
			label: m.target,
			kind: "mount" as const,
		})),
	];
}

async function destinationName(c: Context<Env>, actor: Actor, id: string) {
	const [d] = await c.var.deps.db
		.select({ name: s3Destination.name })
		.from(s3Destination)
		.where(
			and(
				eq(s3Destination.id, id),
				eq(s3Destination.organizationId, actor.organizationId),
			),
		);
	if (!d) throw new Failure("bad_request", "unknown S3 destination");
	return d.name;
}

async function enqueue(c: Context<Env>, job: BackupJob & { runId: string }) {
	await runQueues(c.var.deps.config.REDIS_URL).backup.add("run", job, {
		jobId: job.runId,
		attempts: 1,
		removeOnComplete: { count: 200 },
		removeOnFail: { count: 500 },
	});
}

async function lastRuns(c: Context<Env>, policyIds: string[]) {
	if (!policyIds.length) return new Map<string, RunRow>();
	const rows = await c.var.deps.db
		.selectDistinctOn([backupRun.policyId])
		.from(backupRun)
		.where(
			and(inArray(backupRun.policyId, policyIds), eq(backupRun.kind, "backup")),
		)
		.orderBy(backupRun.policyId, desc(backupRun.startedAt));
	return new Map(rows.map((r) => [r.policyId, r]));
}

async function loadPolicyView(c: Context<Env>, id: string) {
	const { db } = c.var.deps;
	const [row] = await db
		.select({ p: backupPolicy, name: s3Destination.name })
		.from(backupPolicy)
		.innerJoin(
			s3Destination,
			eq(s3Destination.id, backupPolicy.s3DestinationId),
		)
		.where(eq(backupPolicy.id, id));
	if (!row) throw notFound("backup policy");
	return policyView(row.p, row.name, (await lastRuns(c, [id])).get(id));
}

export const backups = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/backups",
			tags: ["backups"],
			security,
			summary: "Backup policies, volumes and recent runs of a service",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(ServiceBackups, "Backups"), ...errors },
		}),
		async (c) => {
			const svc = await serviceRow(c, c.req.valid("param").id);
			const { db } = c.var.deps;
			const policies = await db
				.select({ p: backupPolicy, name: s3Destination.name })
				.from(backupPolicy)
				.innerJoin(
					s3Destination,
					eq(s3Destination.id, backupPolicy.s3DestinationId),
				)
				.where(eq(backupPolicy.serviceId, svc.id))
				.orderBy(asc(backupPolicy.createdAt));
			const ids = policies.map((r) => r.p.id);
			const [last, runs] = await Promise.all([
				lastRuns(c, ids),
				ids.length
					? db
							.select()
							.from(backupRun)
							.where(inArray(backupRun.policyId, ids))
							.orderBy(desc(backupRun.startedAt))
							.limit(50)
					: Promise.resolve([] as RunRow[]),
			]);
			const db_ = svc.spec.kind === "database" ? svc.spec : undefined;
			return c.json(
				{
					service: {
						id: svc.id,
						name: svc.name,
						kind: svc.kind,
						engine: db_?.engine ?? null,
						version: db_?.version ?? null,
					},
					volumes: await volumesOf(c, svc),
					policies: policies.map((r) =>
						policyView(r.p, r.name, last.get(r.p.id)),
					),
					runs: runs.map(runView),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"backup_policy.create",
			createRoute({
				method: "post",
				path: "/services/{id}/backup-policies",
				tags: ["backups"],
				security,
				summary: "Back up a database or a volume on a cron",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam, ...body(PolicyInput) },
				responses: { 201: json(BackupPolicyView, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const svc = await serviceRow(c, c.req.valid("param").id);
			if (input.target === "database" && svc.spec.kind !== "database")
				throw new Failure(
					"bad_request",
					"only database services have a database to dump; back up one of its volumes instead",
				);
			if (input.target === "volume") {
				const volumes = await volumesOf(c, svc);
				if (!volumes.some((v) => v.id === input.volumeName))
					throw new Failure(
						"bad_request",
						"pick one of the service's volumes",
						{
							volumes: volumes.map((v) => v.id),
						},
					);
			} else input.volumeName = null;
			if (input.verifyCron && input.target !== "database")
				throw new Failure(
					"bad_request",
					"verify restores need a database; volume backups have no sanity query",
				);
			if (input.pauseService && input.target !== "volume")
				input.pauseService = false;
			await destinationName(c, actor, input.s3DestinationId);
			const row = one(
				await c.var.deps.db
					.insert(backupPolicy)
					.values({ ...input, serviceId: svc.id })
					.returning(),
			);
			c.set("auditResourceId", row.id);
			await syncPolicySchedulers(runQueues(c.var.deps.config.REDIS_URL), row);
			return c.json(await loadPolicyView(c, row.id), 201);
		},
	)
	.openapi(
		mutation(
			"backup_policy.update",
			createRoute({
				method: "patch",
				path: "/backup-policies/{id}",
				tags: ["backups"],
				security,
				middleware: [requirePermission("write", viaPolicy("policy"))],
				request: { params: IdParam, ...body(PolicyPatch) },
				responses: { 200: json(BackupPolicyView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			c.set("auditResourceId", id);
			const { db } = c.var.deps;
			const current = one(
				await db.select().from(backupPolicy).where(eq(backupPolicy.id, id)),
				"backup policy",
			);
			if (input.s3DestinationId)
				await destinationName(c, requireActor(c), input.s3DestinationId);
			if (input.verifyCron && current.target !== "database")
				throw new Failure("bad_request", "verify restores need a database");
			const row = one(
				await db
					.update(backupPolicy)
					.set(input)
					.where(eq(backupPolicy.id, id))
					.returning(),
			);
			await syncPolicySchedulers(runQueues(c.var.deps.config.REDIS_URL), row);
			return c.json(await loadPolicyView(c, id), 200);
		},
	)
	.openapi(
		mutation(
			"backup_policy.delete",
			createRoute({
				method: "delete",
				path: "/backup-policies/{id}",
				tags: ["backups"],
				security,
				summary: "Stop backing up",
				description:
					"Removes the policy and its run history. Objects already in the bucket stay.",
				middleware: [requirePermission("write", viaPolicy("policy"))],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			await c.var.deps.db.delete(backupPolicy).where(eq(backupPolicy.id, id));
			await dropPolicySchedulers(runQueues(c.var.deps.config.REDIS_URL), id);
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"backup_policy.run",
			createRoute({
				method: "post",
				path: "/backup-policies/{id}/run",
				tags: ["backups"],
				security,
				summary: "Back up (or verify the newest backup) now",
				middleware: [requirePermission("deploy", viaPolicy("policy"))],
				request: {
					params: IdParam,
					...body(
						z.object({ kind: z.enum(["backup", "verify"]).default("backup") }),
					),
				},
				responses: { 202: json(BackupRunView, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { kind } = c.req.valid("json");
			const { db } = c.var.deps;
			const policy = one(
				await db.select().from(backupPolicy).where(eq(backupPolicy.id, id)),
				"backup policy",
			);
			if (kind === "verify" && policy.target !== "database")
				throw new Failure(
					"bad_request",
					"only database backups can be verified",
				);
			const run = one(
				await db
					.insert(backupRun)
					.values({ id: newId("bkr"), policyId: id, kind })
					.returning(),
			);
			c.set("auditResourceId", run.id);
			await enqueue(c, { policyId: id, kind, runId: run.id });
			return c.json(runView(run), 202);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/backup-runs/{id}",
			tags: ["backups"],
			security,
			middleware: [requirePermission("read", viaPolicy("run"))],
			request: { params: IdParam },
			responses: { 200: json(BackupRunView, "Run"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(backupRun)
				.where(eq(backupRun.id, c.req.valid("param").id));
			return c.json(runView(one(rows, "backup run")), 200);
		},
	)
	.openapi(
		mutation(
			"backup_run.restore",
			createRoute({
				method: "post",
				path: "/backup-runs/{id}/restore",
				tags: ["backups"],
				security,
				summary: "Restore a backup into its service or a new one",
				description:
					"`same` overwrites the service's data (a database restore runs `pg_restore --clean`, a volume is emptied first). `new` creates a service beside it with the same engine, version and credentials, deploys it and restores there. `confirm` must be the target service's name.",
				middleware: [requirePermission("write", viaPolicy("run"))],
				request: {
					params: IdParam,
					...body(z.object({ target: RestoreTarget, confirm: z.string() })),
				},
				responses: {
					202: json(
						z.object({ run: BackupRunView, targetServiceId: z.string() }),
						"Queued",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { target, confirm } = c.req.valid("json");
			const { db, bus } = c.var.deps;
			const actor = requireActor(c);
			const [found] = await db
				.select({ run: backupRun, policy: backupPolicy })
				.from(backupRun)
				.innerJoin(backupPolicy, eq(backupPolicy.id, backupRun.policyId))
				.where(eq(backupRun.id, id));
			if (!found) throw notFound("backup run");
			const { run: source, policy } = found;
			if (source.kind !== "backup" || source.status !== "succeeded")
				throw new Failure(
					"bad_request",
					"only a finished backup can be restored",
				);
			if (source.prunedAt || !source.objectKey)
				throw new Failure(
					"bad_request",
					"retention already deleted this backup",
				);
			const svc = await serviceRow(c, policy.serviceId);
			if (
				policy.target === "database" &&
				svc.spec.kind === "database" &&
				dumpOnlyEngines.includes(svc.spec.engine)
			)
				throw new Failure(
					"bad_request",
					`${svc.spec.engine} dumps cannot be restored here; back up and restore the volume instead`,
				);

			const expected = target.kind === "same" ? svc.name : target.name;
			if (confirm !== expected)
				throw new Failure(
					"bad_request",
					`type the service name "${expected}" to confirm`,
				);

			let targetServiceId = svc.id;
			if (target.kind === "new" && policy.target === "database") {
				check(
					c,
					"write",
					await locate(
						db,
						actor.organizationId,
						"environment",
						svc.environmentId,
					),
				);
				const created = one(
					await db
						.insert(service)
						.values({
							environmentId: svc.environmentId,
							name: target.name,
							slug: slugify(target.name),
							kind: svc.kind,
							spec: svc.spec,
							createdBy: actor.userId,
						})
						.returning(),
				);
				targetServiceId = created.id;
				// Same credentials, so the dump's owners and grants resolve in the copy.
				const vars = await db
					.select()
					.from(envVar)
					.where(and(eq(envVar.scope, "service"), eq(envVar.scopeId, svc.id)));
				if (vars.length)
					await db.insert(envVar).values(
						vars.map(({ id: _id, createdAt: _c, updatedAt: _u, ...v }) => ({
							...v,
							scopeId: created.id,
						})),
					);
				const dep = one(
					await db
						.insert(deployment)
						.values({ serviceId: created.id, trigger: "manual" })
						.returning(),
				);
				await bus.publishEvent(
					envelope(
						"deployment.queued",
						actor.organizationId,
						{ type: "deployment", id: dep.id },
						{ serviceId: created.id, trigger: dep.trigger },
					),
				);
			}
			const run = one(
				await db
					.insert(backupRun)
					.values({
						id: newId("bkr"),
						policyId: policy.id,
						kind: "restore",
						sourceRunId: source.id,
						targetServiceId,
					})
					.returning(),
			);
			c.set("auditResourceId", run.id);
			c.set("auditDiff", {
				input: { target, sourceRunId: source.id },
				targetServiceId,
			});
			await enqueue(c, {
				policyId: policy.id,
				kind: "restore",
				runId: run.id,
				sourceRunId: source.id,
				targetServiceId,
				...(target.kind === "new" && policy.target === "volume"
					? { newVolume: true }
					: {}),
			});
			return c.json({ run: runView(run), targetServiceId }, 202);
		},
	);
