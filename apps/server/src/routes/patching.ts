import { createRoute, z } from "@hono/zod-openapi";
import {
	NodePatchStatus,
	PATCH_POLICY_DEFAULT,
	PatchPolicy,
	PatchRun,
	PatchRunInput,
} from "@logistack/contracts";
import {
	type Db,
	node,
	nodePatchStatus,
	patchPolicy,
	patchRun,
} from "@logistack/db";
import { NodeRunnerError } from "@logistack/worker/node-runner";
import {
	agentHost,
	newRunNode,
	saveScan,
	scanHost,
} from "@logistack/worker/patching";
import { syncPatchWindow } from "@logistack/worker/schedulers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Cron, Timezone } from "../cron.ts";
import { Failure, notFound, one } from "../errors.ts";
import { live } from "../live.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { runQueues } from "../run-queues.ts";
import { inOrganization, requirePermission } from "../scope.ts";

const tags = ["patching"];

const PolicyInput = PatchPolicy.extend({ cron: Cron, timezone: Timezone });

const emptyStatus = (nodeId: string): NodePatchStatus => ({
	nodeId,
	packageManager: null,
	os: null,
	kernel: null,
	rebootRequired: false,
	updates: [],
	securityCount: 0,
	scannedAt: null,
	error: null,
});

const statusView = ({
	createdAt: _,
	updatedAt: __,
	...s
}: typeof nodePatchStatus.$inferSelect): NodePatchStatus => s;

const runView = ({
	organizationId: _,
	cancelRequested: __,
	createdBy: ___,
	claimedAt: ____,
	updatedAt: _____,
	...r
}: typeof patchRun.$inferSelect): PatchRun => r;

async function ownNode(db: Db, organizationId: string, id: string) {
	return one(
		await db
			.select()
			.from(node)
			.where(and(eq(node.id, id), eq(node.organizationId, organizationId))),
		"node",
	);
}

async function ownRun(db: Db, organizationId: string, id: string) {
	return one(
		await db
			.select()
			.from(patchRun)
			.where(
				and(eq(patchRun.id, id), eq(patchRun.organizationId, organizationId)),
			),
		"patch run",
	);
}

const active = (state: string) => state === "queued" || state === "running";

export const patching = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/patching/nodes",
			tags,
			security,
			summary: "Pending OS updates of every node, from each node's last scan",
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(
					z.array(NodePatchStatus),
					"Per node, nodes never scanned included",
				),
				...errors,
			},
		}),
		async (c) => {
			const { db } = c.var.deps;
			const rows = await db
				.select({ id: node.id, status: nodePatchStatus })
				.from(node)
				.leftJoin(nodePatchStatus, eq(nodePatchStatus.nodeId, node.id))
				.where(eq(node.organizationId, requireActor(c).organizationId));
			return c.json(
				rows.map((r) => (r.status ? statusView(r.status) : emptyStatus(r.id))),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/nodes/{id}/patches",
			tags,
			security,
			summary: "A node's pending OS updates, kernel and reboot flag",
			middleware: [requirePermission("read", inOrganization)],
			request: { params: IdParam },
			responses: { 200: json(NodePatchStatus, "Last scan"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const row = await ownNode(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			const [s] = await db
				.select()
				.from(nodePatchStatus)
				.where(eq(nodePatchStatus.nodeId, row.id));
			return c.json(s ? statusView(s) : emptyStatus(row.id), 200);
		},
	)
	.openapi(
		mutation(
			"node.patch_scan",
			createRoute({
				method: "post",
				path: "/nodes/{id}/patches/scan",
				tags,
				security,
				summary:
					"Refresh the package index on a node and list its pending updates",
				description:
					"Admins only. Runs `apt-get update` (or `dnf makecache`) on the host through the node's agent; installs nothing. Takes as long as the package index download.",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 200: json(NodePatchStatus, "Scanned"), ...errors },
			}),
		),
		async (c) => {
			const { db, nodes, config } = c.var.deps;
			const row = await ownNode(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			c.set("auditResourceId", row.id);
			let result: Parameters<typeof saveScan>[2];
			try {
				result = await scanHost(
					agentHost(nodes, config.LS_BACKUP_TOOLS_IMAGE, row),
				);
			} catch (e) {
				if (e instanceof NodeRunnerError)
					throw new Failure("conflict", e.message, { reason: e.code });
				result = { error: e instanceof Error ? e.message : String(e) };
			}
			await saveScan(db, row.id, result);
			const [s] = await db
				.select()
				.from(nodePatchStatus)
				.where(eq(nodePatchStatus.nodeId, row.id));
			return c.json(statusView(one(s ? [s] : [], "scan")), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/patching/runs",
			tags,
			security,
			summary: "The latest patch runs, newest first",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(PatchRun), "Runs"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(patchRun)
				.where(eq(patchRun.organizationId, requireActor(c).organizationId))
				.orderBy(desc(patchRun.createdAt))
				.limit(20);
			return c.json(rows.map(runView), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/patching/runs/{id}",
			tags,
			security,
			middleware: [requirePermission("read", inOrganization)],
			request: { params: IdParam },
			responses: { 200: json(PatchRun, "Run"), ...errors },
		}),
		async (c) => {
			const row = await ownRun(
				c.var.deps.db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			return c.json(runView(row), 200);
		},
	)
	.openapi(
		mutation(
			"patch_run.create",
			createRoute({
				method: "post",
				path: "/patching/runs",
				tags,
				security,
				summary: "Patch nodes, one at a time",
				description:
					"Per node, in order: scan, drain, upgrade, reboot when one is due, wait for the node and every service, activate. A failed node stops the run and is activated again. The leader runs LogiStack and is never drained; rebooting it restarts LogiStack.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(PatchRunInput),
				responses: { 201: json(PatchRun, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const { db, config } = c.var.deps;
			const actor = requireActor(c);
			const input = c.req.valid("json");
			const ids = [...new Set(input.nodeIds)];
			const rows = await db
				.select()
				.from(node)
				.where(
					and(
						eq(node.organizationId, actor.organizationId),
						inArray(node.id, ids),
					),
				);
			if (rows.length !== ids.length) throw notFound("node");
			if (rows.some((r) => r.desired === "remove"))
				throw new Failure("conflict", "a node in the run is being removed");
			const running = await db
				.select({ state: patchRun.state })
				.from(patchRun)
				.where(eq(patchRun.organizationId, actor.organizationId));
			if (running.some((r) => active(r.state)))
				throw new Failure(
					"conflict",
					"a patch run is already queued or running; wait for it or cancel it",
				);
			const byId = new Map(rows.map((r) => [r.id, r]));
			const row = one(
				await db
					.insert(patchRun)
					.values({
						organizationId: actor.organizationId,
						trigger: "manual",
						securityOnly: input.securityOnly,
						reboot: input.reboot,
						createdBy: actor.userId ?? null,
						nodes: ids.map((id) =>
							newRunNode(byId.get(id) as (typeof rows)[0]),
						),
					})
					.returning(),
			);
			await (await live(config.REDIS_URL)).poke();
			c.set("auditResourceId", row.id);
			return c.json(runView(row), 201);
		},
	)
	.openapi(
		mutation(
			"patch_run.cancel",
			createRoute({
				method: "post",
				path: "/patching/runs/{id}/cancel",
				tags,
				security,
				summary: "Stop a patch run after the step in progress",
				description:
					"An upgrade already running finishes first; the node is then activated and the remaining nodes are skipped.",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 200: json(PatchRun, "Cancelling"), ...errors },
			}),
		),
		async (c) => {
			const { db } = c.var.deps;
			const row = await ownRun(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			if (!active(row.state))
				throw new Failure("conflict", `the run is ${row.state}`);
			// A queued run has no worker yet to see the flag, so it ends here.
			const updated = one(
				await db
					.update(patchRun)
					.set(
						row.state === "queued"
							? {
									state: "cancelled",
									error: "cancelled",
									finishedAt: new Date(),
									nodes: row.nodes.map((n) => ({
										...n,
										state: "skipped" as const,
										error: "cancelled",
									})),
								}
							: { cancelRequested: true },
					)
					.where(eq(patchRun.id, row.id))
					.returning(),
			);
			c.set("auditResourceId", row.id);
			return c.json(runView(updated), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/patching/policy",
			tags,
			security,
			summary: "The organization's patch window",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(PatchPolicy, "Policy"), ...errors },
		}),
		async (c) => {
			const [p] = await c.var.deps.db
				.select()
				.from(patchPolicy)
				.where(eq(patchPolicy.organizationId, requireActor(c).organizationId));
			const {
				organizationId: _,
				createdAt: __,
				updatedAt: ___,
				...view
			} = p ?? {
				...PATCH_POLICY_DEFAULT,
				organizationId: "",
				createdAt: 0,
				updatedAt: 0,
			};
			return c.json(view, 200);
		},
	)
	.openapi(
		mutation(
			"patch_policy.update",
			createRoute({
				method: "put",
				path: "/patching/policy",
				tags,
				security,
				summary:
					"Set the patch window: a rolling run over every active node on a cron",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(PolicyInput),
				responses: { 200: json(PatchPolicy, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const { db, config } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const input = c.req.valid("json");
			await db
				.insert(patchPolicy)
				.values({ organizationId, ...input })
				.onConflictDoUpdate({ target: patchPolicy.organizationId, set: input });
			await syncPatchWindow(runQueues(config.REDIS_URL), organizationId, input);
			c.set("auditResourceId", organizationId);
			return c.json(input, 200);
		},
	);
