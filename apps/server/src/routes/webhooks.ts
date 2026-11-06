import { createRoute, z } from "@hono/zod-openapi";
import { ApiError } from "@logistack/contracts";
import {
	DEFAULT_GIT_TRIGGER,
	evaluateTrigger,
	type TriggerDecision,
} from "@logistack/core";
import {
	deployment,
	environment,
	project,
	service,
	serviceGitTrigger,
	serviceWatchPaths,
} from "@logistack/db";
import { type GitEvent, WebhookRejectedError } from "@logistack/providers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { mutation } from "../audit.ts";
import { envelope } from "../events.ts";
import { client, loadProvider, providerState } from "../git/providers.ts";
import { json, router } from "../openapi.ts";
import { handlePullRequest } from "../previews.ts";
import { syncGitStacks } from "./stacks.ts";

const Outcome = z
	.object({
		/**
		 * `deployed`: at least one deployment queued or awaiting checks. `skipped`: services were addressed
		 * but rules held every one back; each got a `skipped` deployment with its reason. `ignored`: nothing to do.
		 */
		outcome: z.enum(["deployed", "skipped", "ignored", "removed"]),
		reason: z.string().optional(),
		/** Queued or awaiting-checks deployments. */
		deployments: z.array(z.string()),
		/** Deployments recorded as `skipped`. */
		skipped: z.array(z.string()),
		/** Pull request events: what each project with previews did. */
		previews: z
			.array(
				z.object({
					projectId: z.string(),
					outcome: z.enum(["updated", "removed", "skipped"]),
					reason: z.string().optional(),
					deployments: z.array(z.string()),
				}),
			)
			.optional(),
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
	skipped: [],
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
				"Public. Authenticated by the provider's signature (HMAC, or GitLab's secret token). Each service building from the repository applies its trigger rules (branch, tag pattern or release; skip markers; watch paths): a match queues a `git_push` deployment, or holds it in `awaiting_checks` when the service waits for CI; a rule that holds it back records a `skipped` deployment with the reason. A pull request event creates, updates or removes the `pr-<number>` preview environment of each project whose preview settings follow the repository.",
			request: { params: z.object({ providerId: z.string() }) },
			responses: {
				200: json(Outcome, "Deployments queued"),
				202: json(Outcome, "Authentic, skipped or ignored"),
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
		if (event.kind === "pull_request") {
			const previews = await handlePullRequest(
				c.var.deps,
				{
					id: row.id,
					organizationId: row.organizationId,
					...(providerState(row.kind, config) === "connected" && {
						client: client(row.kind, config),
					}),
				},
				event,
			);
			if (!previews.length)
				return c.json(
					{ ...ignored("no project previews this repository"), previews },
					202,
				);
			const deployments = previews.flatMap((p) => p.deployments);
			const reason = previews
				.flatMap((p) => (p.reason ? [p.reason] : []))
				.join("; ");
			return c.json(
				{
					outcome: deployments.length
						? ("deployed" as const)
						: previews.some((p) => p.outcome === "removed")
							? ("removed" as const)
							: ("skipped" as const),
					...(reason && { reason }),
					deployments,
					skipped: [],
					previews,
				},
				deployments.length ? 200 : 202,
			);
		}

		// Stacks first: their own deployments cover the services a sync changed.
		const stacks = await syncGitStacks(c, row.id, row.organizationId, event);
		const viaStack = new Set(stacks.deployments.map((d) => d.serviceId));

		const targets = await db
			.select({
				service,
				paths: serviceWatchPaths.paths,
				trigger: serviceGitTrigger,
			})
			.from(service)
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.innerJoin(project, eq(project.id, environment.projectId))
			.leftJoin(serviceWatchPaths, eq(serviceWatchPaths.serviceId, service.id))
			.leftJoin(serviceGitTrigger, eq(serviceGitTrigger.serviceId, service.id))
			.where(
				and(
					eq(project.organizationId, row.organizationId),
					eq(service.desiredState, "running"),
					// A managed preview follows its pull request's events, not pushes.
					isNull(environment.preview),
					sql`${service.spec}->'source'->>'type' = 'git'`,
					sql`${service.spec}->'source'->>'gitProviderId' = ${row.id}`,
				),
			);
		const push = event;
		const decisions: { serviceId: string; decision: TriggerDecision }[] = [];
		for (const { service: s, paths, trigger } of targets) {
			if (!("source" in s.spec) || s.spec.source.type !== "git") continue;
			const src = s.spec.source;
			if (src.repository.toLowerCase() !== push.repo.toLowerCase()) continue;
			if (viaStack.has(s.id)) continue;
			decisions.push({
				serviceId: s.id,
				decision: evaluateTrigger(push, {
					...(trigger ?? DEFAULT_GIT_TRIGGER),
					branch: src.branch,
					watchPaths: paths ?? [],
				}),
			});
		}
		const addressed = decisions.filter((d) => d.decision.action !== "ignore");
		const ids = stacks.deployments.map((d) => d.id);
		const reasons = new Set(stacks.failures);
		if (!addressed.length && !ids.length)
			return c.json(
				ignored(
					[
						...stacks.failures,
						targets.length
							? `no service is triggered by this ${push.ref.kind} event`
							: "no service builds from this provider",
					].join("; "),
				),
				202,
			);

		const skipped: string[] = [];
		for (const { serviceId, decision } of addressed) {
			const waiting = decision.action === "deploy" && decision.waitForChecks;
			const [d] = await db
				.insert(deployment)
				.values({
					serviceId,
					trigger: "git_push",
					status:
						decision.action === "skip"
							? "skipped"
							: waiting
								? "awaiting_checks"
								: "queued",
					commitSha: push.commitSha ?? null,
					commitMessage: push.commitMessage.split("\n")[0]?.slice(0, 500) ?? "",
					gitRef: push.ref.kind === "branch" ? null : push.ref.name,
					reason:
						decision.action === "skip"
							? decision.reason
							: waiting
								? "Waiting for the commit's checks to pass"
								: null,
					...(decision.action === "skip" ? { finishedAt: new Date() } : {}),
				})
				.returning({ id: deployment.id });
			if (!d) continue;
			if (decision.action === "skip") {
				skipped.push(d.id);
				reasons.add(decision.reason);
				continue;
			}
			ids.push(d.id);
			// The worker's checks poller queues an awaiting deployment once CI settles.
			if (waiting) continue;
			await bus.publishEvent(
				envelope(
					"deployment.queued",
					row.organizationId,
					{ type: "deployment", id: d.id },
					{
						serviceId,
						trigger: "git_push",
						commitSha: push.commitSha,
						author: push.author,
					},
				),
			);
		}
		if (!ids.length)
			return c.json(
				{
					outcome: "skipped" as const,
					reason: [...reasons].join("; "),
					deployments: [],
					skipped,
				},
				202,
			);
		return c.json(
			{
				outcome: "deployed" as const,
				...(stacks.failures.length && { reason: stacks.failures.join("; ") }),
				deployments: ids,
				skipped,
			},
			200,
		);
	},
);
