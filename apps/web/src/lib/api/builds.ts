import type { BuildPlatforms } from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";

export type { BuildPlatforms };

export type BuildsApi = {
	platforms(): Promise<BuildPlatforms>;
	/** Queues a BuildKit probe; `buildkit.checkedAt` moves when it lands. */
	check(): Promise<BuildPlatforms>;
	/** Queues the QEMU setup; `buildkit.emulation.state` reports it. */
	setUpEmulation(): Promise<BuildPlatforms>;
};

const a = client.api["build-platforms"];
const http: BuildsApi = {
	platforms: () => ok(a.$get()),
	check: () => ok(a.check.$post()),
	setUpEmulation: () => ok(a.emulation.$post()),
};

export const buildsApi: BuildsApi = isMock
	? (await import("./mock/builds")).mockBuilds
	: http;

export const isInstalling = (p: BuildPlatforms | undefined) =>
	p?.buildkit.emulation?.state === "installing";

export const buildPlatformsQuery = queryOptions({
	queryKey: ["build-platforms"],
	queryFn: () => buildsApi.platforms(),
	staleTime: 30_000,
	refetchInterval: (q) => (isInstalling(q.state.data) ? 2_000 : false),
});

/** Resolves once the worker has answered a probe queued now, or after a minute. */
async function probed(): Promise<BuildPlatforms> {
	const before = await buildsApi.check();
	const since = before.buildkit.checkedAt;
	for (let i = 0; i < 60; i++) {
		await new Promise((r) => setTimeout(r, 1_000));
		const now = await buildsApi.platforms();
		if (now.buildkit.checkedAt !== since) return now;
	}
	throw new Error("The worker didn't answer within a minute. Is it running?");
}

export function useCheckBuildkit() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: probed,
		onSuccess: (p) => qc.setQueryData(buildPlatformsQuery.queryKey, p),
	});
}

export function useSetUpEmulation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => buildsApi.setUpEmulation(),
		onSuccess: (p) => qc.setQueryData(buildPlatformsQuery.queryKey, p),
	});
}

/** `linux/arm64` reads as `arm64` everywhere in the UI. */
export const archOf = (platform: string) => platform.split("/")[1] ?? platform;
