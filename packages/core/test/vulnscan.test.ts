import { expect, test } from "bun:test";
import { TrivyReport, vulnBadge } from "@logistack/contracts";
import { newCriticals, parseTrivyReport } from "../src/vulnscan.ts";

const report = TrivyReport.parse({
	Results: [
		{
			Target: "alpine",
			Vulnerabilities: [
				{
					VulnerabilityID: "CVE-1",
					PkgName: "musl",
					InstalledVersion: "1.1.22-r2",
					FixedVersion: "1.1.22-r3",
					Severity: "CRITICAL",
				},
				{
					VulnerabilityID: "CVE-2",
					PkgName: "zlib",
					InstalledVersion: "1.2",
					Severity: "LOW",
				},
				{
					VulnerabilityID: "CVE-3",
					PkgName: "x",
					InstalledVersion: "1",
					Severity: "WHATEVER",
				},
			],
		},
		// Trivy repeats a package found in another target.
		{
			Vulnerabilities: [
				{
					VulnerabilityID: "CVE-1",
					PkgName: "musl",
					InstalledVersion: "1.1.22-r2",
					FixedVersion: "1.1.22-r3",
					Severity: "CRITICAL",
				},
			],
		},
		{ Vulnerabilities: null },
	],
});

test("dedupes, normalizes severity and counts", () => {
	const { findings, counts } = parseTrivyReport(report);
	expect(findings.map((f) => f.id)).toEqual(["CVE-1", "CVE-2", "CVE-3"]);
	expect(findings[1]?.fixedVersion).toBeNull();
	expect(counts).toEqual({
		critical: 1,
		high: 0,
		medium: 0,
		low: 1,
		unknown: 1,
	});
	expect(vulnBadge(counts)).toBe("critical");
	expect(vulnBadge({ ...counts, critical: 0 })).toBe("low");
	expect(
		vulnBadge({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }),
	).toBe("clean");
});

test("an empty image has no findings", () => {
	expect(parseTrivyReport(TrivyReport.parse({})).findings).toEqual([]);
});

test("only criticals not seen before are new", () => {
	const { findings } = parseTrivyReport(report);
	expect(newCriticals([], findings)).toEqual(["CVE-1"]);
	expect(newCriticals(["CVE-1"], findings)).toEqual([]);
});
