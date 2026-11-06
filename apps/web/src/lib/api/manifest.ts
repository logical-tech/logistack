/*
 * Project and environment manifests: export the desired state as YAML, plan and apply one.
 */
import type { ManifestChange } from "@logistack/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

export type { ManifestChange };

/** What a manifest applies to; a project manifest only applies to a project, and so on. */
export type ManifestScope = { kind: "project" | "environment"; id: string };

export type ApplyResult = {
	applied: boolean;
	changes: ManifestChange[];
	warnings: string[];
	/** Age keys of backup policies apply created; the server shows them once. */
	backupKeys: {
		environment: string;
		service: string;
		backup: string;
		key: string;
	}[];
};

export type ManifestApi = {
	/** The manifest as YAML, with its `yaml-language-server` schema modeline. */
	export(scope: ManifestScope): Promise<string>;
	/** `manifest` is the file's text, YAML or JSON; with `dryRun` nothing is written. */
	apply(
		scope: ManifestScope,
		input: { manifest: string; prune: boolean; dryRun: boolean },
	): Promise<ApplyResult>;
};

const routes = (kind: ManifestScope["kind"]) =>
	kind === "project"
		? client.api.projects[":id"]
		: client.api.environments[":id"];

const http: ManifestApi = {
	export: async ({ kind, id }) => {
		const pending = routes(kind).manifest.$get({
			param: { id },
			query: { format: "yaml" },
		});
		await done(pending);
		return (await pending).text();
	},
	apply: ({ kind, id }, json) =>
		ok(routes(kind).apply.$post({ param: { id }, json })),
};

export const manifestApi: ManifestApi = isMock
	? (await import("./mock/manifest")).mockManifest
	: http;

/** Saves the manifest as `<name>.logistack.yaml`. */
export async function downloadManifest(scope: ManifestScope, name: string) {
	const yaml = await manifestApi.export(scope);
	const a = document.createElement("a");
	a.href = URL.createObjectURL(new Blob([yaml], { type: "text/yaml" }));
	a.download = `${name}.logistack.yaml`;
	a.click();
	URL.revokeObjectURL(a.href);
}

export function useApplyManifest() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			scope,
			...input
		}: {
			scope: ManifestScope;
			manifest: string;
			prune: boolean;
		}) => manifestApi.apply(scope, { ...input, dryRun: false }),
		// Apply can touch projects, services, stacks, domains, variables and backups alike.
		onSuccess: () => qc.invalidateQueries(),
	});
}
