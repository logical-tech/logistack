import { createRoute } from "@hono/zod-openapi";
import {
	type BuildkitState,
	BuildPlatforms,
	emptyBuildkitState,
} from "@logistack/contracts";
import { missingPlatforms, platformsOfArchs } from "@logistack/core";
import { instanceSettings, node } from "@logistack/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure } from "../errors.ts";
import { errors, json, router, security } from "../openapi.ts";
import { runQueues } from "../run-queues.ts";
import { inOrganization, requirePermission } from "../scope.ts";

const tags = ["builds"];
/** A setup stuck this long (worker restarted mid-way) may be started again. */
const STALE_MS = 15 * 60_000;

async function read(c: Context<Env>) {
	const { db } = c.var.deps;
	const nodes = await db
		.select({ facts: node.facts })
		.from(node)
		.where(eq(node.organizationId, requireActor(c).organizationId));
	const [s] = await db
		.select({ buildkit: instanceSettings.buildkit })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	const buildkit = s?.buildkit ?? emptyBuildkitState;
	return {
		swarm: platformsOfArchs(nodes.flatMap((n) => n.facts.architecture ?? [])),
		buildkit,
		missing: buildkit.platforms ? missingPlatforms(buildkit.platforms) : [],
	};
}

export const buildPlatforms = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/build-platforms",
			tags,
			security,
			summary: "Build architectures: the swarm's, BuildKit's, and QEMU setup",
			description:
				"What an automatic build targets (the architectures of the swarm's nodes), which platforms BuildKit last reported it can build, and the state of the guided QEMU emulation setup. `missing` lists the selectable platforms BuildKit cannot build yet.",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(BuildPlatforms, "Build platforms"), ...errors },
		}),
		async (c) => c.json(await read(c), 200),
	)
	.openapi(
		mutation(
			"build_platforms.check",
			createRoute({
				method: "post",
				path: "/build-platforms/check",
				tags,
				security,
				summary: "Ask BuildKit again which platforms it can build",
				description:
					"Queues a probe (`buildctl debug workers`) on the worker, starting BuildKit if needed. Poll GET /build-platforms for `buildkit.checkedAt` to change.",
				middleware: [requirePermission("admin", inOrganization)],
				responses: { 202: json(BuildPlatforms, "Probe queued"), ...errors },
			}),
		),
		async (c) => {
			await runQueues(c.var.deps.config.REDIS_URL).maintenance.add(
				"buildkit-probe",
				{},
				{ removeOnComplete: true, removeOnFail: { count: 20 } },
			);
			return c.json(await read(c), 202);
		},
	)
	.openapi(
		mutation(
			"build_platforms.emulation",
			createRoute({
				method: "post",
				path: "/build-platforms/emulation",
				tags,
				security,
				summary: "Set up QEMU emulation for cross-architecture builds",
				description:
					"Runs tonistiigi/binfmt once, as a Swarm job with CAP_SYS_ADMIN on BuildKit's node, to register QEMU for the missing platforms in that node's kernel, then restarts BuildKit so it detects them. The registration lasts until the node reboots. Poll GET /build-platforms for `buildkit.emulation.state`.",
				middleware: [requirePermission("admin", inOrganization)],
				responses: { 202: json(BuildPlatforms, "Setup queued"), ...errors },
			}),
		),
		async (c) => {
			const { db } = c.var.deps;
			const current = await read(c);
			const running = current.buildkit.emulation;
			if (
				running?.state === "installing" &&
				Date.now() - Date.parse(running.at) < STALE_MS
			)
				throw new Failure("conflict", "the QEMU setup is already running");
			const buildkit: BuildkitState = {
				...current.buildkit,
				emulation: {
					state: "installing",
					error: null,
					at: new Date().toISOString(),
				},
			};
			await db
				.update(instanceSettings)
				.set({ buildkit })
				.where(eq(instanceSettings.id, "singleton"));
			await runQueues(c.var.deps.config.REDIS_URL).maintenance.add(
				"binfmt-install",
				{},
				{ removeOnComplete: true, removeOnFail: { count: 20 } },
			);
			return c.json({ ...current, buildkit }, 202);
		},
	);
