import { createRoute, z } from "@hono/zod-openapi";
import { UpdateState, UpdateSteps } from "@logistack/contracts";
import {
	compareVersions,
	isReleaseVersion,
	normalizeVersion,
} from "@logistack/core";
import { instanceSettings, instanceUpdate } from "@logistack/db";
import { latestRelease, type Release } from "@logistack/providers";
import { desc, eq, inArray } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure } from "../errors.ts";
import { live } from "../live.ts";
import { log } from "../log.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import {
	inOrganization,
	requireInstanceAdmin,
	requirePermission,
} from "../scope.ts";

const tags = ["updates"];

const ReleaseView = z
	.object({
		version: z.string(),
		name: z.string(),
		notes: z.string(),
		url: z.string(),
		publishedAt: z.string().nullable(),
	})
	.openapi("Release");

const UpdateRun = z
	.object({
		id: z.string(),
		fromVersion: z.string(),
		toVersion: z.string(),
		state: UpdateState,
		steps: UpdateSteps,
		log: z.array(z.string()),
		error: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi("UpdateRun");

const UpdateStatus = z
	.object({
		/** What GET /api/version reports. */
		current: z.object({ version: z.string(), commit: z.string().nullable() }),
		latest: ReleaseView.nullable(),
		/** Why `latest` is missing when GitHub could not be asked. */
		latestError: z.string().nullable(),
		checkedAt: z.string().nullable(),
		updateAvailable: z.boolean(),
		autoCheck: z.boolean(),
		/** `latest` includes prereleases, the builds of `staging`. */
		beta: z.boolean(),
		run: UpdateRun.nullable(),
	})
	.openapi("UpdateStatus");

/** GitHub allows 60 unauthenticated requests an hour per IP; one answer serves every viewer. */
const FRESH_MS = 3_600_000;
const RETRY_MS = 300_000;
const FORCE_MIN_MS = 60_000;
type Check = { at: number; release: Release | null; error: string | null };
/** One entry per channel, so flipping beta updates never serves the other channel's answer. */
const cache = new Map<boolean, Check>();

async function latest(force: boolean, beta: boolean) {
	const cached = cache.get(beta);
	const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY;
	const ttl = cached?.error ? RETRY_MS : FRESH_MS;
	if (cached && age < (force ? FORCE_MIN_MS : ttl)) return cached;
	let next: Check;
	try {
		next = {
			at: Date.now(),
			release: await latestRelease({}, { beta }),
			error: null,
		};
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		log("warn", "release check failed", { error });
		// Keep showing the last release we saw; only the error is new.
		next = { at: Date.now(), release: cached?.release ?? null, error };
	}
	cache.set(beta, next);
	return next;
}

const runView = (r: typeof instanceUpdate.$inferSelect) => ({
	id: r.id,
	fromVersion: r.fromVersion,
	toVersion: r.toVersion,
	state: r.state,
	steps: r.steps,
	log: r.log,
	error: r.error,
	createdAt: r.createdAt.toISOString(),
	updatedAt: r.updatedAt.toISOString(),
});

export const updates = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/instance/update",
			tags,
			security,
			summary: "Running version, the latest release and the last update",
			middleware: [requirePermission("read", inOrganization)],
			request: {
				query: z.object({
					/** Ask GitHub again unless it was asked in the last minute. */
					refresh: z.stringbool().optional(),
				}),
			},
			responses: { 200: json(UpdateStatus, "Update status"), ...errors },
		}),
		async (c) => {
			const { db, config } = c.var.deps;
			const [[settings], [run]] = await Promise.all([
				db
					.select({
						autoCheck: instanceSettings.autoCheckUpdates,
						beta: instanceSettings.betaUpdates,
					})
					.from(instanceSettings),
				db
					.select()
					.from(instanceUpdate)
					.orderBy(desc(instanceUpdate.createdAt))
					.limit(1),
			]);
			const beta = settings?.beta ?? false;
			const check = await latest(c.req.valid("query").refresh ?? false, beta);
			const current = config.LOGISTACK_VERSION;
			return c.json(
				{
					current: {
						version: current,
						commit: config.LOGISTACK_COMMIT ?? null,
					},
					latest: check.release,
					latestError: check.error,
					checkedAt: new Date(check.at).toISOString(),
					updateAvailable:
						!!check.release &&
						compareVersions(check.release.version, current) > 0,
					autoCheck: settings?.autoCheck ?? true,
					beta,
					run: run ? runView(run) : null,
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"instance.upgrade",
			createRoute({
				method: "post",
				path: "/instance/update",
				tags,
				security,
				summary:
					"Update every LogiStack service to a release, api first and worker last",
				// shortcut: any organization admin updates the instance; split out an instance-admin role once instances host several organizations.
				middleware: [
					requirePermission("admin", inOrganization),
					requireInstanceAdmin,
				],
				request: body(z.object({ version: z.string().min(1).max(64) })),
				responses: { 202: json(UpdateRun, "Update queued"), ...errors },
			}),
		),
		async (c) => {
			const { db, config } = c.var.deps;
			const version = normalizeVersion(c.req.valid("json").version);
			if (!isReleaseVersion(version))
				throw new Failure("bad_request", "version must look like 1.2.3");
			const current = config.LOGISTACK_VERSION;
			if (compareVersions(version, current) <= 0)
				throw new Failure(
					"conflict",
					`this instance already runs ${current}; updates only move forward`,
				);
			const busy = await db.$count(
				instanceUpdate,
				inArray(instanceUpdate.state, ["queued", "running"]),
			);
			if (busy) throw new Failure("conflict", "an update is already running");
			const [row] = await db
				.insert(instanceUpdate)
				.values({
					fromVersion: current,
					toVersion: version,
					requestedBy: requireActor(c).id,
				})
				.returning();
			if (!row) throw new Error("insert returned nothing");
			await (await live(config.REDIS_URL)).poke();
			c.set("auditResourceId", row.id);
			c.set("auditDiff", { from: current, to: version });
			return c.json(runView(row), 202);
		},
	)
	.openapi(
		mutation(
			"instance.update",
			createRoute({
				method: "put",
				path: "/instance/update/auto-check",
				tags,
				security,
				summary: "Check GitHub daily and notify when a newer release is out",
				middleware: [
					requirePermission("admin", inOrganization),
					requireInstanceAdmin,
				],
				request: body(z.object({ enabled: z.boolean() })),
				responses: {
					200: json(z.object({ enabled: z.boolean() }), "Saved"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { enabled } = c.req.valid("json");
			await c.var.deps.db
				.update(instanceSettings)
				.set({ autoCheckUpdates: enabled })
				.where(eq(instanceSettings.id, "singleton"));
			c.set("auditDiff", { after: { autoCheckUpdates: enabled } });
			return c.json({ enabled }, 200);
		},
	)
	.openapi(
		mutation(
			"instance.update",
			createRoute({
				method: "put",
				path: "/instance/update/beta",
				tags,
				security,
				summary:
					"Offer staging builds (prereleases) as updates, not only stable releases",
				middleware: [
					requirePermission("admin", inOrganization),
					requireInstanceAdmin,
				],
				request: body(z.object({ enabled: z.boolean() })),
				responses: {
					200: json(z.object({ enabled: z.boolean() }), "Saved"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { enabled } = c.req.valid("json");
			await c.var.deps.db
				.update(instanceSettings)
				.set({ betaUpdates: enabled })
				.where(eq(instanceSettings.id, "singleton"));
			c.set("auditDiff", { after: { betaUpdates: enabled } });
			return c.json({ enabled }, 200);
		},
	);
