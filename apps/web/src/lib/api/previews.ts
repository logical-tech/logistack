/* Pull request preview settings: straight to the API; in mock mode an in-memory copy per project. */
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";

type Route = (typeof client.api.projects)[":id"]["previews"];
export type PreviewSettings = NonNullable<
	InferResponseType<Route["$get"], 200>
>;
export type PreviewSettingsInput = InferRequestType<Route["$put"]>["json"];

const mock = new Map<string, PreviewSettings>();
const hideSecrets = (s: PreviewSettings): PreviewSettings => ({
	...s,
	variables: s.variables.map(({ value, ...v }) =>
		v.secret ? v : { ...v, value },
	),
});

export const previewSettingsQuery = (projectId: string) =>
	queryOptions({
		queryKey: ["previews", projectId],
		queryFn: (): Promise<PreviewSettings | null> =>
			isMock
				? Promise.resolve(mock.get(projectId) ?? null)
				: ok(
						client.api.projects[":id"].previews.$get({
							param: { id: projectId },
						}),
					),
	});

export function useSavePreviewSettings(projectId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (json: PreviewSettingsInput) => {
			if (!isMock)
				return ok(
					client.api.projects[":id"].previews.$put({
						param: { id: projectId },
						json,
					}),
				);
			const saved = {
				maxPreviews: 5,
				ttlHours: 72,
				allowForks: false,
				...json,
				services: json.services ?? [],
				stacks: json.stacks ?? [],
				variables: (json.variables ?? []).map((v) => ({
					...v,
					secret: v.secret ?? true,
				})),
			};
			mock.set(projectId, saved);
			return hideSecrets(saved);
		},
		onSuccess: (saved) => qc.setQueryData(["previews", projectId], saved),
	});
}
