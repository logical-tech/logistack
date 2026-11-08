import type { ReleaseChannel } from "@logistack/contracts";

/** `1.2.3` or `1.2.3-rc.1`, with an optional leading `v` as git tags carry it. */
const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export const isReleaseVersion = (v: string) => RELEASE.test(v);

/** Strips the tag's leading `v`: `v1.2.3` -> `1.2.3`. */
export const normalizeVersion = (v: string) => v.replace(/^v(?=\d)/, "");

function compareIds(a: string, b: string): number {
	const na = /^\d+$/.test(a);
	const nb = /^\d+$/.test(b);
	if (na && nb) return Number(a) - Number(b);
	if (na !== nb) return na ? -1 : 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence: negative when `a` is older than `b`. A prerelease sorts before its release,
 * and anything that is not a release (`dev`, a local build's `unknown`) before every release.
 */
export function compareVersions(a: string, b: string): number {
	const ma = RELEASE.exec(a);
	const mb = RELEASE.exec(b);
	if (!ma || !mb) return (ma ? 1 : 0) - (mb ? 1 : 0);
	for (let i = 1; i <= 3; i++) {
		const d = Number(ma[i]) - Number(mb[i]);
		if (d) return d;
	}
	const [pa, pb] = [ma[4], mb[4]];
	if (pa === undefined || pb === undefined)
		return (pa === undefined ? 1 : 0) - (pb === undefined ? 1 : 0);
	const xa = pa.split(".");
	const xb = pb.split(".");
	for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
		const d = compareIds(xa[i] as string, xb[i] as string);
		if (d) return d;
	}
	return xa.length - xb.length;
}

const CHANNEL_RANK: Record<ReleaseChannel, number> = {
	stable: 0,
	beta: 1,
	nightly: 2,
};

/** The channel a version ships on: no prerelease is stable, `-nightly.N` nightly, any other prerelease beta. */
export function versionChannel(v: string): ReleaseChannel {
	const pre = RELEASE.exec(v)?.[4];
	if (pre === undefined) return "stable";
	return pre.startsWith("nightly") ? "nightly" : "beta";
}

/** Each channel also offers every less adventurous one: beta gets stable releases, nightly gets both. */
export const onChannel = (v: string, channel: ReleaseChannel) =>
	isReleaseVersion(v) &&
	CHANNEL_RANK[versionChannel(v)] <= CHANNEL_RANK[channel];

/** The `## Breaking changes` section `.github/release-notes.sh` writes first, up to the next `##`. */
const BREAKING =
	/^##[ \t]+Breaking changes[ \t]*\r?\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/im;

/** The notes' breaking changes without their heading, or null when the notes have none. */
export function breakingChanges(notes: string): string | null {
	return BREAKING.exec(notes)?.[1]?.trim() || null;
}

/** The notes without their breaking changes, for a page that shows those apart. */
export const withoutBreakingChanges = (notes: string) =>
	notes.replace(BREAKING, "").trim();

/**
 * The releases an update from `current` to `target` crosses, newest first: every stable release in
 * between, plus the target. A prerelease's notes already cover everything since the last stable
 * release, so the betas or nightlies before it would only repeat them.
 */
export function releasesBetween<T extends { version: string }>(
	releases: T[],
	current: string,
	target: string,
): T[] {
	return releases
		.filter(
			(r) =>
				compareVersions(r.version, current) > 0 &&
				compareVersions(r.version, target) <= 0 &&
				(compareVersions(r.version, target) === 0 ||
					versionChannel(r.version) === "stable"),
		)
		.sort((a, b) => compareVersions(b.version, a.version));
}
