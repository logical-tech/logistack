import type { DeploymentStatus } from "@logistack/contracts";
import { decrypt } from "@logistack/core";
import {
	deployment,
	environment,
	project,
	registry,
	registryRetention,
	service,
} from "@logistack/db";
import { and, eq, isNotNull, like } from "drizzle-orm";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";

const DEFAULT_KEEP = 10;

type Dep = { id: string; createdAt: Date; status: DeploymentStatus };

/**
 * Pure: the tags of one service repository to delete. Tags are deployment ids; the newest `keep`
 * deployments and the newest healthy one (what runs now) survive. Tags no deployment explains
 * are left alone.
 */
export function tagsToDelete(
	tags: readonly string[],
	deployments: readonly Dep[],
	keep: number,
): string[] {
	const present = new Set(tags);
	const known = deployments
		.filter((d) => present.has(d.id))
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	const kept = new Set(known.slice(0, keep).map((d) => d.id));
	const live = known.find((d) => d.status === "healthy");
	if (live) kept.add(live.id);
	return known.filter((d) => !kept.has(d.id)).map((d) => d.id);
}

const MANIFEST_TYPES = [
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

const loopback = (host: string) =>
	/^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/.test(host);

/**
 * shortcut: the distribution API calls retention needs, duplicated from apps/server/src/registry/client.ts
 * (apps cannot share code outside packages/*); move both into packages/providers.
 */
function registryApi(
	host: string,
	creds?: { username: string; password: string },
) {
	const base = `${loopback(host) ? "http" : "https"}://${host === "docker.io" ? "registry-1.docker.io" : host}/v2`;
	const basic = creds
		? `Basic ${btoa(`${creds.username}:${creds.password}`)}`
		: undefined;
	let auth: string | undefined;
	return async (path: string, init: RequestInit, scope: string) => {
		const send = () =>
			fetch(`${base}${path}`, {
				...init,
				headers: {
					...(init.headers as Record<string, string>),
					...(auth ? { authorization: auth } : {}),
				},
				signal: AbortSignal.timeout(30_000),
			});
		let res = await send();
		if (res.status === 401) {
			const challenge = res.headers.get("www-authenticate") ?? "";
			const bearer = /^Bearer\s+(.*)$/i.exec(challenge);
			if (bearer) {
				const p = Object.fromEntries(
					[...(bearer[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
						m[1],
						m[2],
					]),
				);
				const url = new URL(p.realm ?? "");
				if (p.service) url.searchParams.set("service", p.service);
				url.searchParams.set("scope", scope);
				const t = await fetch(url, {
					headers: basic ? { authorization: basic } : {},
				});
				const body = (await t.json()) as {
					token?: string;
					access_token?: string;
				};
				auth = `Bearer ${body.token ?? body.access_token}`;
			} else auth = basic;
			res = await send();
		}
		return res;
	};
}

/** The maintenance job: prunes old deployment images in every registry with a password LogiStack holds. */
export async function pruneImages(ctx: Ctx): Promise<{ deleted: string[] }> {
	const deleted: string[] = [];
	const regs = await ctx.db
		.select({ registry, keep: registryRetention.keepTags })
		.from(registry)
		.leftJoin(registryRetention, eq(registryRetention.registryId, registry.id));
	for (const { registry: r, keep } of regs) {
		const host = r.url.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");
		const rows = await ctx.db
			.select({
				id: deployment.id,
				createdAt: deployment.createdAt,
				status: deployment.status,
				imageRef: deployment.imageRef,
			})
			.from(deployment)
			.innerJoin(service, eq(service.id, deployment.serviceId))
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.innerJoin(project, eq(project.id, environment.projectId))
			.where(
				and(
					eq(project.organizationId, r.organizationId),
					isNotNull(deployment.imageRef),
					like(deployment.imageRef, `${host}/%`),
				),
			);
		const apiHost = host.split("/")[0] as string;
		const repos = new Map<string, Dep[]>();
		for (const d of rows) {
			// `<apiHost>/<repository>:<deploymentId>`
			const ref = d.imageRef as string;
			const repo = ref.slice(apiHost.length + 1, ref.lastIndexOf(":"));
			repos.set(repo, [...(repos.get(repo) ?? []), d]);
		}
		if (!repos.size) continue;
		const api = registryApi(
			apiHost,
			r.username && r.passwordEncrypted
				? {
						username: r.username,
						password: await decrypt(ctx.masterKey, r.passwordEncrypted),
					}
				: undefined,
		);
		for (const [repo, deps] of repos) {
			const scope = `repository:${repo}:pull,push,delete`;
			try {
				const list = await api(`/${repo}/tags/list`, {}, scope);
				if (!list.ok) throw new Error(`tags/list answered ${list.status}`);
				const tags =
					((await list.json()) as { tags?: string[] | null }).tags ?? [];
				const drop = new Set(tagsToDelete(tags, deps, keep ?? DEFAULT_KEEP));
				if (!drop.size) continue;
				const digests = new Map<string, string>();
				for (const tag of tags) {
					const head = await api(
						`/${repo}/manifests/${tag}`,
						{ method: "HEAD", headers: { accept: MANIFEST_TYPES } },
						scope,
					);
					const digest = head.headers.get("docker-content-digest");
					if (digest) digests.set(tag, digest);
				}
				// A digest a kept tag also points at (an identical rebuild) is never deleted.
				const keptDigests = new Set(
					tags.filter((t) => !drop.has(t)).map((t) => digests.get(t)),
				);
				for (const tag of drop) {
					const digest = digests.get(tag);
					if (!digest || keptDigests.has(digest)) continue;
					const del = await api(
						`/${repo}/manifests/${digest}`,
						{ method: "DELETE" },
						scope,
					);
					if (del.status !== 202 && del.status !== 200)
						throw new Error(
							`deleting ${tag} answered ${del.status} (the registry may not allow deletes)`,
						);
					deleted.push(`${apiHost}/${repo}:${tag}`);
				}
			} catch (e) {
				log("warn", "image retention skipped a repository", {
					registryId: r.id,
					repo,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
	}
	if (deleted.length)
		log("info", "pruned old images", { count: deleted.length });
	return { deleted };
}
