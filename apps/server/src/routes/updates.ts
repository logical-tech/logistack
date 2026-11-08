import { createRoute, z } from "@hono/zod-openapi";
import { ReleaseChannel, UpdateState, UpdateSteps } from "@logistack/contracts";
import {
	breakingChanges,
	compareVersions,
	isReleaseVersion,
	normalizeVersion,
	releasesBetween,
} from "@logistack/core";
import { instanceSettings, instanceUpdate } from "@logistack/db";
import { listReleases, type Release } from "@logistack/providers";
import { desc, eq, inArray } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Deps } from "../env.ts";
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

const ChangelogEntry = ReleaseView.extend({
	/** The notes' `## Breaking changes` section, without its heading; null when there is none. */
	breaking: z.string().nullable(),
}).openapi("ChangelogEntry");

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
		/** Which builds `latest` is picked from. */
		channel: ReleaseChannel,
		/** `channel` is not stable. Kept for API clients that predate channels. */
		beta: z.boolean(),
		/**
		 * The releases an update to `latest` crosses, newest first: the stable ones on the way and
		 * `latest` itself. Empty when there is no update.
		 */
		changelog: z.array(ChangelogEntry),
		run: UpdateRun.nullable(),
	})
	.openapi("UpdateStatus");

/** GitHub allows 60 unauthenticated requests an hour per IP; one answer serves every viewer. */
const FRESH_MS = 3_600_000;
const RETRY_MS = 300_000;
const FORCE_MIN_MS = 60_000;
type Check = { at: number; releases: Release[]; error: string | null };
/** One entry per channel, so switching channels never serves the other channel's answer. */
const cache = new Map<ReleaseChannel, Check>();

async function check(force: boolean, channel: ReleaseChannel) {
	const cached = cache.get(channel);
	const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY;
	const ttl = cached?.error ? RETRY_MS : FRESH_MS;
	if (cached && age < (force ? FORCE_MIN_MS : ttl)) return cached;
	let next: Check;
	try {
		next = {
			at: Date.now(),
			releases: await listReleases({}, { channel }),
			error: null,
		};
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		log("warn", "release check failed", { error });
		// Keep showing the last releases we saw; only the error is new.
		next = { at: Date.now(), releases: cached?.releases ?? [], error };
	}
	cache.set(channel, next);
	return next;
}

/** `betaUpdates` stays in step for a previous release that reads it during an update or after a rollback. */
const setChannel = (db: Deps["db"], channel: ReleaseChannel) =>
	db
		.update(instanceSettings)
		.set({ updateChannel: channel, betaUpdates: channel !== "stable" })
		.where(eq(instanceSettings.id, "singleton"));

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
						channel: instanceSettings.updateChannel,
					})
					.from(instanceSettings),
				db
					.select()
					.from(instanceUpdate)
					.orderBy(desc(instanceUpdate.createdAt))
					.limit(1),
			]);
			const channel = settings?.channel ?? "stable";
			const { releases, at, error } = await check(
				c.req.valid("query").refresh ?? false,
				channel,
			);
			const latest = releases[0] ?? null;
			const current = config.LOGISTACK_VERSION;
			const updateAvailable =
				!!latest && compareVersions(latest.version, current) > 0;
			return c.json(
				{
					current: {
						version: current,
						commit: config.LOGISTACK_COMMIT ?? null,
					},
					latest,
					latestError: error,
					checkedAt: new Date(at).toISOString(),
					updateAvailable,
					autoCheck: settings?.autoCheck ?? true,
					channel,
					beta: channel !== "stable",
					changelog:
						latest && updateAvailable
							? releasesBetween(releases, current, latest.version).map((r) => ({
									...r,
									breaking: breakingChanges(r.notes),
								}))
							: [],
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
					"Deprecated: PUT /instance/update/channel. true picks the beta channel, false stable",
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
			await setChannel(c.var.deps.db, enabled ? "beta" : "stable");
			c.set("auditDiff", {
				after: { updateChannel: enabled ? "beta" : "stable" },
			});
			return c.json({ enabled }, 200);
		},
	)
	.openapi(
		mutation(
			"instance.update",
			createRoute({
				method: "put",
				path: "/instance/update/channel",
				tags,
				security,
				summary:
					"Pick the builds offered as updates: stable releases, betas of staging, or nightlies of develop",
				middleware: [
					requirePermission("admin", inOrganization),
					requireInstanceAdmin,
				],
				request: body(z.object({ channel: ReleaseChannel })),
				responses: {
					200: json(z.object({ channel: ReleaseChannel }), "Saved"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { channel } = c.req.valid("json");
			await setChannel(c.var.deps.db, channel);
			c.set("auditDiff", { after: { updateChannel: channel } });
			return c.json({ channel }, 200);
		},
	);
