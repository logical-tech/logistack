import { createRoute, z } from "@hono/zod-openapi";
import { ApiError } from "@logistack/contracts";
import {
	deployment,
	environment,
	project,
	service,
	serviceWatchPaths,
} from "@logistack/db";
import { type GitEvent, WebhookRejectedError } from "@logistack/providers";
import { and, eq, sql } from "drizzle-orm";
import { mutation } from "../audit.ts";
import { envelope } from "../events.ts";
import { client, loadProvider, providerState } from "../git/providers.ts";
import { json, router } from "../openapi.ts";

const trim = (p: string) => p.replace(/^\/+|\/+$/g, "");

/**
 * Pure: whether a push touching `changed` should deploy a service watching `watch`. No watch paths,
 * or a provider that could not list the files, deploys. A glob matches with Bun.Glob; a plain path
 * is a directory prefix.
 */
export function touchesWatchPaths(
	changed: string[] | undefined,
	watch: readonly string[],
): boolean {
	if (!watch.length || changed === undefined) return true;
	return changed.some((file) =>
		watch.some((w) => {
			const pattern = trim(w);
			if (/[*?[{]/.test(pattern)) return new Bun.Glob(pattern).match(file);
			return file === pattern || file.startsWith(`${pattern}/`);
		}),
	);
}

const Outcome = z
	.object({
		/** `deployed`: one deployment per matching service. `ignored`: authentic, nothing to do. */
		outcome: z.enum(["deployed", "ignored"]),
		reason: z.string().optional(),
		deployments: z.array(z.string()),
	})
	.openapi("WebhookOutcome");

const error = (description: string) => ({
	content: { "application/json": { schema: ApiError } },
	description,
});

const ignored = (reason: string) => ({
	outcome: "ignored" as const,
	reason,
	deployments: [],
});

export const webhooks = router().openapi(
	mutation(
		"webhook.git",
		createRoute({
			method: "post",
			path: "/webhooks/git/{providerId}",
			tags: ["webhooks"],
			summary: "Push and pull request events from a Git provider",
			description:
				"Public. Authenticated by the provider's signature (HMAC, or GitLab's secret token). A push to a tracked branch that touches a watched path queues a `git_push` deployment of every matching service.",
			request: { params: z.object({ providerId: z.string() }) },
			responses: {
				200: json(Outcome, "Deployments queued"),
				202: json(Outcome, "Authentic, ignored"),
				400: error("Malformed payload"),
				401: error("Missing or invalid signature"),
				404: error("Unknown provider"),
			},
		}),
	),
	async (c) => {
		const { db, masterKey, bus } = c.var.deps;
		const { row, config } = await loadProvider(
			db,
			masterKey,
			c.req.valid("param").providerId,
		);
		const raw = await c.req.text();
		let event: GitEvent | null;
		try {
			// A GitHub App not installed yet still has its webhook secret; the placeholder id is never used to call GitHub.
			const verifier =
				providerState(row.kind, config) === "pending"
					? client(row.kind, { ...config, installationId: "0" })
					: client(row.kind, config);
			event = await verifier.verifyWebhook(c.req.raw.headers, raw);
		} catch (e) {
			if (e instanceof WebhookRejectedError)
				return c.json(
					{ error: { code: "unauthorized" as const, message: e.message } },
					401,
				);
			return c.json(
				{
					error: {
						code: "bad_request" as const,
						message: `unreadable ${row.kind} payload`,
					},
				},
				400,
			);
		}
		if (!event) return c.json(ignored("event not used by LogiStack"), 202);
		if (event.kind !== "push")
			return c.json(ignored("pull request previews are not enabled"), 202);

		const targets = await db
			.select({ service, paths: serviceWatchPaths.paths })
			.from(service)
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.innerJoin(project, eq(project.id, environment.projectId))
			.leftJoin(serviceWatchPaths, eq(serviceWatchPaths.serviceId, service.id))
			.where(
				and(
					eq(project.organizationId, row.organizationId),
					eq(service.desiredState, "running"),
					sql`${service.spec}->'source'->>'type' = 'git'`,
					sql`${service.spec}->'source'->>'gitProviderId' = ${row.id}`,
				),
			);
		const push = event;
		const matching = targets.filter(({ service: s, paths }) => {
			if (!("source" in s.spec) || s.spec.source.type !== "git") return false;
			const src = s.spec.source;
			return (
				src.repository.toLowerCase() === push.repo.toLowerCase() &&
				src.branch === push.branch &&
				touchesWatchPaths(push.changedPaths, paths ?? [])
			);
		});
		if (!matching.length)
			return c.json(
				ignored(
					targets.length
						? "no service tracks this branch with a matching watch path"
						: "no service builds from this provider",
				),
				202,
			);

		const ids: string[] = [];
		for (const { service: s } of matching) {
			const [d] = await db
				.insert(deployment)
				.values({
					serviceId: s.id,
					trigger: "git_push",
					commitSha: push.commitSha,
					commitMessage: push.commitMessage.split("\n")[0]?.slice(0, 500) ?? "",
				})
				.returning({ id: deployment.id });
			if (!d) continue;
			ids.push(d.id);
			await bus.publishEvent(
				envelope(
					"deployment.queued",
					row.organizationId,
					{ type: "deployment", id: d.id },
					{
						serviceId: s.id,
						trigger: "git_push",
						commitSha: push.commitSha,
						author: push.author,
					},
				),
			);
		}
		return c.json({ outcome: "deployed" as const, deployments: ids }, 200);
	},
);
