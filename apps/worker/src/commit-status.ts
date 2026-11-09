import type { EventEnvelope, EventType } from "@logistack/contracts";
import { decrypt } from "@logistack/core";
import {
	deployment,
	environment,
	gitProvider,
	instanceSettings,
	project,
	service,
} from "@logistack/db";
import {
	type GitProvider,
	gitProviders,
	Http,
	instantiate,
	LOGISTACK_CHECK,
	ownerRepoPath,
} from "@logistack/providers";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "./ctx.ts";

type GitHubState = "pending" | "success" | "failure" | "error";

const states: Partial<
	Record<EventType, { state: GitHubState; description: string }>
> = {
	"deployment.started": { state: "pending", description: "Deploying" },
	"deployment.succeeded": { state: "success", description: "Deployed" },
	"deployment.failed": { state: "failure", description: "Deployment failed" },
	"deployment.cancelled": {
		state: "error",
		description: "Deployment cancelled or superseded",
	},
};

/** Mirrors a deployment's state onto its commit on GitHub. Other providers and commitless deployments are skipped. */
export async function reportCommitStatus(
	ctx: Ctx,
	e: EventEnvelope,
): Promise<boolean> {
	const mapped = states[e.type];
	if (!mapped || e.resource.type !== "deployment") return false;
	const [row] = await ctx.db
		.select({
			commitSha: deployment.commitSha,
			spec: service.spec,
			projectId: environment.projectId,
			preview: environment.preview,
			organizationId: project.organizationId,
		})
		.from(deployment)
		.innerJoin(service, eq(service.id, deployment.serviceId))
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(eq(deployment.id, e.resource.id));
	if (!row?.commitSha || row.spec.kind !== "application") return false;
	const source = row.spec.source;
	if (source.type !== "git" || !source.gitProviderId) return false;
	const [gp] = await ctx.db
		.select()
		.from(gitProvider)
		.where(
			and(
				eq(gitProvider.id, source.gitProviderId),
				eq(gitProvider.organizationId, row.organizationId),
			),
		);
	if (gp?.kind !== "github") return false;
	const provider = instantiate(
		gitProviders.github,
		JSON.parse(await decrypt(ctx.masterKey, gp.configEncrypted)),
	) as GitProvider;
	// The clone URL carries a fresh installation token (cached by the provider) as its password.
	const token = decodeURIComponent(
		new URL(await provider.getCloneUrl(source.repository)).password,
	);
	const [settings] = await ctx.db
		.select({ publicUrl: instanceSettings.publicUrl })
		.from(instanceSettings);
	await new Http("github").postJson(
		"commitStatus",
		`https://api.github.com/repos/${ownerRepoPath("github", source.repository)}/statuses/${encodeURIComponent(row.commitSha)}`,
		{
			state: mapped.state,
			context: LOGISTACK_CHECK,
			description: mapped.description,
			// A preview links to itself; anything else to its project in LogiStack.
			...(row.preview?.urls[0]
				? { target_url: row.preview.urls[0] }
				: settings?.publicUrl
					? {
							target_url: `${settings.publicUrl.replace(/\/+$/, "")}/projects/${row.projectId}`,
						}
					: {}),
		},
		{
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			"user-agent": "LogiStack",
			authorization: `Bearer ${token}`,
		},
	);
	return true;
}
