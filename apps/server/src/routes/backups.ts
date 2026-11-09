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
import { encrypt, newId } from "@logistack/core";
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
import { generateX25519Identity } from "age-encryption";
import { and, asc, desc, eq, inArray, isNull, like } from "drizzle-orm";
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
	refuseArchived,
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
		/** Backups are age-encrypted before upload; the bucket only holds ciphertext. */
		encrypted: z.boolean(),
		/** A finished backup is encrypted: the key can no longer be replaced or dropped. */
		hasEncryptedBackup: z.boolean(),
		enabled: z.boolean(),
		nextRunAt: z.string().nullable(),
		nextVerifyAt: z.string().nullable(),
		lastRun: BackupRunView.nullable(),
		createdAt: z.string(),
	})
	.openapi("BackupPolicy");

const BackupPolicyWithKey = BackupPolicyView.extend({
	/** The age identity, returned once: by the request that turned encryption on. */
	encryptionKey: z.string().nullable(),
}).openapi("BackupPolicyWithKey");

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

// No defaults here: zod applies them inside .partial(), so a patch would reset unsent fields.
const PolicyFields = z.object({
	s3DestinationId: z.string(),
	cron: Cron,
	timezone: Timezone,
	retention: BackupRetention,
	verifyCron: Cron.nullable(),
	pauseService: z.boolean(),
	enabled: z.boolean(),
	/** `true` issues an age key (a new one while no encrypted backup exists); `false` drops it, also only while none exists. */
	encrypt: z.boolean(),
});

const PolicyInput = PolicyFields.extend({
	timezone: Timezone.default("UTC"),
	retention: BackupRetention.default({ count: 7 }),
	verifyCron: Cron.nullable().default(null),
	pauseService: z.boolean().default(false),
	enabled: z.boolean().default(true),
	encrypt: z.boolean().default(false),
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
	hasEncryptedBackup: boolean,
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
	encrypted: p.encryptionKeyEncrypted !== null,
	hasEncryptedBackup,
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

/** A new age identity: the plaintext for the caller, once, and the sealed copy to store. */
async function newBackupKey(c: Context<Env>) {
	const key = await generateX25519Identity();
	return { key, sealed: await encrypt(c.var.deps.masterKey, key) };
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

/** Policies with at least one finished encrypted backup: for those the key is irreplaceable. */
async function withEncryptedBackup(c: Context<Env>, policyIds: string[]) {
	if (!policyIds.length) return new Set<string>();
	const rows = await c.var.deps.db
		.selectDistinct({ id: backupRun.policyId })
		.from(backupRun)
		.where(
			and(
				inArray(backupRun.policyId, policyIds),
				eq(backupRun.kind, "backup"),
				eq(backupRun.status, "succeeded"),
				like(backupRun.objectKey, "%.age"),
			),
		);
	return new Set(rows.map((r) => r.id));
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
	return policyView(
		row.p,
		row.name,
		(await lastRuns(c, [id])).get(id),
		(await withEncryptedBackup(c, [id])).has(id),
	);
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
			const [last, sealedBackups, runs] = await Promise.all([
				lastRuns(c, ids),
				withEncryptedBackup(c, ids),
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
						policyView(
							r.p,
							r.name,
							last.get(r.p.id),
							sealedBackups.has(r.p.id),
						),
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
				description:
					"With `encrypt`, every backup is encrypted with a new age key before upload. The response carries that key once in `encryptionKey`: store it, since losing it loses the backups once LogiStack is gone. Decrypt with `age -d -i key.txt`.",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam, ...body(PolicyInput) },
				responses: { 201: json(BackupPolicyWithKey, "Created"), ...errors },
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
			const { encrypt: wantsKey, ...fields } = input;
			const key = wantsKey ? await newBackupKey(c) : undefined;
			const row = one(
				await c.var.deps.db
					.insert(backupPolicy)
					.values({
						...fields,
						serviceId: svc.id,
						encryptionKeyEncrypted: key?.sealed ?? null,
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			await syncPolicySchedulers(runQueues(c.var.deps.config.REDIS_URL), row);
			return c.json(
				{
					...(await loadPolicyView(c, row.id)),
					encryptionKey: key?.key ?? null,
				},
				201,
			);
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
				summary: "Change a backup policy",
				description:
					"`encrypt: true` on a plaintext policy creates an age key and returns it once in `encryptionKey`; later backups are encrypted, older ones stay plaintext. Until a backup has been encrypted, `encrypt: true` again issues a fresh key (use it when the first one was lost) and `encrypt: false` removes the key; after that both are refused because existing backups need the key. Answers 409 if another change to the key landed first.",
				middleware: [requirePermission("write", viaPolicy("policy"))],
				request: { params: IdParam, ...body(PolicyPatch) },
				responses: { 200: json(BackupPolicyWithKey, "Updated"), ...errors },
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
			const { encrypt: wantsKey, ...fields } = input;
			const previous = current.encryptionKeyEncrypted;
			const locked = (await withEncryptedBackup(c, [id])).has(id);
			if (wantsKey === false && previous !== null && locked)
				throw new Failure(
					"bad_request",
					"encryption cannot be turned off: an encrypted backup exists and needs its key",
				);
			// A key nobody saved can be replaced until a backup depends on it.
			const key =
				wantsKey && !(previous !== null && locked)
					? await newBackupKey(c)
					: undefined;
			const dropKey = wantsKey === false && previous !== null;
			const changesKey = key !== undefined || dropKey;
			const [row] = await db
				.update(backupPolicy)
				.set({
					...fields,
					updatedAt: new Date(),
					...(key ? { encryptionKeyEncrypted: key.sealed } : {}),
					...(dropKey ? { encryptionKeyEncrypted: null } : {}),
				})
				.where(
					and(
						eq(backupPolicy.id, id),
						// Compare-and-set on the sealed key, so concurrent key changes cannot both win.
						changesKey
							? previous === null
								? isNull(backupPolicy.encryptionKeyEncrypted)
								: eq(backupPolicy.encryptionKeyEncrypted, previous)
							: undefined,
					),
				)
				.returning();
			if (!row)
				throw new Failure(
					"conflict",
					"the backup key changed in the meantime; reload and try again",
				);
			await syncPolicySchedulers(runQueues(c.var.deps.config.REDIS_URL), row);
			return c.json(
				{
					...(await loadPolicyView(c, id)),
					encryptionKey: key?.key ?? null,
				},
				200,
			);
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
					"`same` overwrites the service's data (a database restore runs `pg_restore --clean`, a volume is emptied first). `new` creates a service beside it with the same engine, version and credentials, deploys it and restores there. `confirm` must be the target service's name. `same` needs `admin` on the service.",
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
			// Overwriting live data is an admin action, like POST /databases/{id}/restore.
			if (target.kind === "same")
				check(
					c,
					"admin",
					await locate(db, actor.organizationId, "service", svc.id),
				);
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
				// The new database is deployed, and an archived project starts nothing.
				await refuseArchived(c);
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
