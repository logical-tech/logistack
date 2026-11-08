import {
	type DeployGateRequest,
	DeployGateResponse,
} from "@logistack/contracts";
import { decrypt, pluginBaseUrl } from "@logistack/core";
import {
	environment,
	pluginGateDecision,
	pluginInstall,
	project,
} from "@logistack/db";
import { callPlugin, type Fetch, guardedFetch } from "@logistack/providers";
import { and, asc, eq } from "drizzle-orm";
import type { Ctx } from "./ctx.ts";
import type { ServiceContext } from "./load.ts";
import { hostPolicy } from "./ssrf.ts";

// Deploy gates (docs/plans/plugins.md, phase 4): before a rollout, every enabled install in
// the organization that declares `contributes.gates.deploy` is asked `POST /v1/gates/deploy`.
// The first rejection fails the deployment with the plugin's reason. An answer is stored per
// deployment and install, so a retried or resumed deployment does not ask again.

export type GateResult = { ok: true } | { ok: false; error: string };

type Deployment = {
	id: string;
	trigger: string;
	commitSha: string | null;
	commitMessage: string | null;
	gitRef: string | null;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runDeployGates(
	ctx: Ctx,
	sc: ServiceContext,
	d: Deployment,
	imageRef: string,
	line: (s: string) => void,
	/** Tests call loopback plugins without the SSRF guard. */
	fetchFor?: Fetch,
): Promise<GateResult> {
	const installs = (
		await ctx.db
			.select()
			.from(pluginInstall)
			.where(
				and(
					eq(pluginInstall.organizationId, sc.organizationId),
					eq(pluginInstall.enabled, true),
				),
			)
			.orderBy(asc(pluginInstall.id))
	).filter((r) => r.manifest.contributes.gates?.deploy);
	if (!installs.length) return { ok: true };

	const [where] = await ctx.db
		.select({
			projectId: project.id,
			environmentKind: environment.kind,
		})
		.from(environment)
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(eq(environment.id, sc.service.environmentId));
	const request: DeployGateRequest = {
		deploymentId: d.id,
		organizationId: sc.organizationId,
		project: { id: where?.projectId ?? "", name: sc.projectName },
		environment: {
			id: sc.service.environmentId,
			name: sc.environmentName,
			kind: where?.environmentKind ?? "",
		},
		service: {
			id: sc.service.id,
			name: sc.service.name,
			kind: sc.service.kind,
		},
		imageRef,
		commitSha: d.commitSha,
		commitMessage: d.commitMessage,
		gitRef: d.gitRef,
		trigger: d.trigger,
	};

	for (const row of installs) {
		const name = row.manifest.name;
		const [stored] = await ctx.db
			.select()
			.from(pluginGateDecision)
			.where(
				and(
					eq(pluginGateDecision.deploymentId, d.id),
					eq(pluginGateDecision.installId, row.id),
				),
			);
		let answer: DeployGateResponse | undefined = stored && {
			allow: stored.allowed,
			...(stored.reason ? { reason: stored.reason } : {}),
		};
		if (answer) line(`==> gate ${name}: answered earlier`);
		else {
			line(`==> gate ${name}: asking`);
			const policy = row.devUrl && !fetchFor ? await hostPolicy(ctx.db) : null;
			const f: Fetch =
				fetchFor ??
				(policy
					? (url, init) =>
							guardedFetch(url, init ?? {}, policy, undefined, true)
					: (url, init) => fetch(url, init));
			try {
				const raw = await callPlugin(
					{
						baseUrl: pluginBaseUrl(row, ctx.cfg.LS_NAME_PREFIX),
						installId: row.id,
						signingSecret: await decrypt(
							ctx.masterKey,
							row.signingSecretEncrypted,
						),
					},
					"/v1/gates/deploy",
					request,
					{ fetch: f, timeoutMs: row.gateTimeoutSeconds * 1000 },
				);
				const parsed = DeployGateResponse.safeParse(raw);
				if (!parsed.success)
					throw new Error("the plugin answered without a boolean `allow`");
				answer = parsed.data;
				const { allow, reason } = parsed.data;
				await ctx.db
					.insert(pluginGateDecision)
					.values({
						deploymentId: d.id,
						installId: row.id,
						allowed: allow,
						reason: reason ?? null,
					})
					.onConflictDoNothing();
			} catch (e) {
				const why = errMsg(e);
				if (row.gateFailOpen) {
					line(`==> gate ${name}: no answer (${why}); fail-open, going ahead`);
					continue;
				}
				return {
					ok: false,
					error: `deploy gate ${name} did not answer (${why}); it fails closed`,
				};
			}
		}
		if (!answer.allow)
			return {
				ok: false,
				error: `rejected by deploy gate ${name}${answer.reason ? `: ${answer.reason}` : ""}`,
			};
		line(
			`==> gate ${name}: allowed${answer.reason ? ` (${answer.reason})` : ""}`,
		);
	}
	return { ok: true };
}
