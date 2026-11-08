import {
	type TrivyReport,
	type VulnCounts,
	type Vulnerability,
	VulnSeverity,
} from "@logistack/contracts";

const RANK: Record<VulnSeverity, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
	unknown: 4,
};

/** One row per vulnerability, package and installed version (Trivy repeats them per layer target), worst first. */
export function parseTrivyReport(report: TrivyReport): {
	findings: Vulnerability[];
	counts: VulnCounts;
} {
	const byKey = new Map<string, Vulnerability>();
	for (const r of report.Results ?? [])
		for (const v of r.Vulnerabilities ?? []) {
			const f: Vulnerability = {
				id: v.VulnerabilityID,
				severity: VulnSeverity.catch("unknown").parse(v.Severity.toLowerCase()),
				pkgName: v.PkgName,
				installedVersion: v.InstalledVersion,
				fixedVersion: v.FixedVersion || null,
				title: v.Title ?? null,
				url: v.PrimaryURL ?? null,
			};
			byKey.set(`${f.id}\0${f.pkgName}\0${f.installedVersion}`, f);
		}
	const findings = [...byKey.values()].sort(
		(a, b) =>
			RANK[a.severity] - RANK[b.severity] ||
			a.pkgName.localeCompare(b.pkgName) ||
			a.id.localeCompare(b.id),
	);
	const counts: VulnCounts = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		unknown: 0,
	};
	for (const f of findings) counts[f.severity]++;
	return { findings, counts };
}

/** Critical vulnerability ids in `now` that `before` did not have. */
export const newCriticals = (
	before: Iterable<string>,
	now: Vulnerability[],
) => {
	const seen = new Set(before);
	return [
		...new Set(
			now
				.filter((f) => f.severity === "critical" && !seen.has(f.id))
				.map((f) => f.id),
		),
	];
};
