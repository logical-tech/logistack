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
