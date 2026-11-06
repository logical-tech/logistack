import { type BuildConfig, BuildPlatform } from "@logistack/contracts";

const byArch: Record<string, BuildPlatform> = {
	x86_64: "linux/amd64",
	amd64: "linux/amd64",
	aarch64: "linux/arm64",
	arm64: "linux/arm64",
};

/** Pure: the build platforms of a set of node architectures (`uname -m` or Go names), sorted; others are dropped. */
export const platformsOfArchs = (archs: readonly string[]): BuildPlatform[] =>
	BuildPlatform.options.filter((p) =>
		archs.some((a) => byArch[a.toLowerCase()] === p),
	);

/** Pure: the selectable platforms a BuildKit worker cannot build (`os/arch[/variant]` as it reports them). */
export const missingPlatforms = (
	buildkit: readonly string[],
): BuildPlatform[] =>
	BuildPlatform.options.filter(
		(p) => !buildkit.some((b) => b === p || b.startsWith(`${p}/`)),
	);

/**
 * Pure: what a build targets. An explicit choice wins; otherwise every architecture in the swarm,
 * or BuildKit's native one when the swarm reports none it knows. Railpack builds one platform, so
 * on a mixed swarm it builds the native one and placement keeps the image on matching nodes.
 */
export function resolveBuildPlatforms(o: {
	build: BuildConfig;
	swarm: readonly BuildPlatform[];
	native: BuildPlatform;
}): BuildPlatform[] {
	const explicit = "platforms" in o.build ? o.build.platforms : undefined;
	if (explicit)
		return BuildPlatform.options.filter((p) => explicit.includes(p));
	if (!o.swarm.length) return [o.native];
	if (o.build.type === "railpack" && o.swarm.length > 1) return [o.native];
	return [...o.swarm];
}
