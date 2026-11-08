/* GitOps: a project that follows a manifest in git. Straight to the API; in mock mode an in-memory link per project. */
import type { ManifestChange } from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

type Route = (typeof client.api.projects)[":id"]["gitops"];
export type GitopsLink = NonNullable<InferResponseType<Route["$get"], 200>>;
export type GitopsInput = InferRequestType<Route["$put"]>["json"];
export type GitopsSource = Pick<
	GitopsInput,
	"gitProviderId" | "repository" | "branch" | "path"
>;
export type GitopsPlan = { changes: ManifestChange[]; warnings: string[] };
export type GitopsSync = InferResponseType<Route["sync"]["$post"], 200>;

const mock = new Map<string, GitopsLink>([
	[
		"prj_storefront",
		{
			projectId: "prj_storefront",
			gitProviderId: "gpr_github",
			repository: "acme-retail/infra",
			branch: "main",
			path: "storefront/logistack.yaml",
			autoApply: true,
			prune: false,
			managed: true,
			lastCommitSha: "9f2c4e1a7b3d5c6e8f9a0b1c2d3e4f5a6b7c8d9e",
			lastSyncedAt: "2026-11-08T09:12:00.000Z",
			lastStatus: "failed",
			lastChanges: 0,
			lastError: {
				at: "2026-11-08T09:12:00.000Z",
				commitSha: "9f2c4e1a7b3d5c6e8f9a0b1c2d3e4f5a6b7c8d9e",
				message:
					"storefront/logistack.yaml: the manifest names organization resources that are not here",
				details: [
					'DNS provider "cloudflare-prod" does not exist in this organization',
				],
			},
			createdAt: "2026-11-01T10:00:00.000Z",
			updatedAt: "2026-11-08T09:12:00.000Z",
		},
	],
]);

export const gitopsQuery = (projectId: string) =>
	queryOptions({
		queryKey: ["gitops", projectId],
		queryFn: (): Promise<GitopsLink | null> =>
			isMock
				? Promise.resolve(mock.get(projectId) ?? null)
				: ok(
						client.api.projects[":id"].gitops.$get({
							param: { id: projectId },
						}),
					),
	});

/** Reads the manifest from git and plans it; writes nothing. */
export const checkGitops = (
	projectId: string,
	json: GitopsSource & { prune: boolean },
): Promise<GitopsPlan> =>
	isMock
		? Promise.resolve({
				changes: [
					{
						op: "update",
						resource: "service",
						environment: "production",
						name: "web",
						changes: ["spec.replicas changed"],
					},
				],
				warnings: [],
			})
		: ok(
				client.api.projects[":id"].gitops.check.$post({
					param: { id: projectId },
					json,
				}),
			);

export function useLinkGitops(projectId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (json: GitopsInput): Promise<GitopsLink> => {
			if (!isMock)
				return ok(
					client.api.projects[":id"].gitops.$put({
						param: { id: projectId },
						json,
					}),
				);
			const now = new Date().toISOString();
			const link: GitopsLink = {
				projectId,
				autoApply: true,
				prune: false,
				managed: false,
				...json,
				lastCommitSha: null,
				lastSyncedAt: null,
				lastStatus: null,
				lastChanges: null,
				lastError: null,
				createdAt: now,
				updatedAt: now,
			};
			mock.set(projectId, link);
			return link;
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["gitops", projectId] }),
	});
}

export function useSyncGitops(projectId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (): Promise<GitopsSync> =>
			isMock
				? Promise.resolve({
						status: "unchanged",
						commitSha: null,
						changes: 0,
						deployments: [],
					})
				: ok(
						client.api.projects[":id"].gitops.sync.$post({
							param: { id: projectId },
						}),
					),
		// A sync can touch anything in the project.
		onSettled: () => qc.invalidateQueries(),
	});
}

export function useUnlinkGitops(projectId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			if (isMock) return void mock.delete(projectId);
			await done(
				client.api.projects[":id"].gitops.$delete({ param: { id: projectId } }),
			);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["gitops", projectId] }),
	});
}
