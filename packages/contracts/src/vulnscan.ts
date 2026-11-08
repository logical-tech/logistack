import { z } from "zod";

/** Image scans run one at a time, apart from deploys, so a scan never delays a deployment. */
export const SCAN_QUEUE = "scan";
/** One service's current image, or every image in use (the daily pass). */
export type ScanJob = { serviceId: string } | { all: true };

export const VulnSeverity = z.enum([
	"critical",
	"high",
	"medium",
	"low",
	"unknown",
]);
export type VulnSeverity = z.infer<typeof VulnSeverity>;

export const VulnCounts = z.object({
	critical: z.number().int(),
	high: z.number().int(),
	medium: z.number().int(),
	low: z.number().int(),
	unknown: z.number().int(),
});
export type VulnCounts = z.infer<typeof VulnCounts>;

export const VulnBadge = z.enum(["clean", "low", "high", "critical"]);
export type VulnBadge = z.infer<typeof VulnBadge>;

/** Worst severity found, with medium, low and unknown folded into `low`. */
export function vulnBadge(c: VulnCounts): VulnBadge {
	if (c.critical) return "critical";
	if (c.high) return "high";
	return c.medium + c.low + c.unknown ? "low" : "clean";
}

export const ScanStatus = z.enum(["running", "succeeded", "failed"]);
export type ScanStatus = z.infer<typeof ScanStatus>;

export const Vulnerability = z.object({
	id: z.string(),
	severity: VulnSeverity,
	pkgName: z.string(),
	installedVersion: z.string(),
	fixedVersion: z.string().nullable(),
	title: z.string().nullable(),
	url: z.string().nullable(),
});
export type Vulnerability = z.infer<typeof Vulnerability>;

export const ServiceVulnerabilities = z.object({
	/** The image the service runs; null before its first deployment is scanned. */
	image: z.string().nullable(),
	digest: z.string().nullable(),
	status: ScanStatus.nullable(),
	badge: VulnBadge.nullable(),
	counts: VulnCounts.nullable(),
	scannedAt: z.coerce.date().nullable(),
	error: z.string().nullable(),
	/** Worst first. */
	findings: z.array(Vulnerability),
});
export type ServiceVulnerabilities = z.infer<typeof ServiceVulnerabilities>;

/** The part of `trivy image --format json` the scanner reads. */
export const TrivyReport = z.object({
	Results: z
		.array(
			z.object({
				Vulnerabilities: z
					.array(
						z.object({
							VulnerabilityID: z.string(),
							PkgName: z.string(),
							InstalledVersion: z.string().default(""),
							FixedVersion: z.string().optional(),
							Severity: z.string(),
							Title: z.string().optional(),
							PrimaryURL: z.string().optional(),
						}),
					)
					.nullish(),
			}),
		)
		.nullish(),
});
export type TrivyReport = z.infer<typeof TrivyReport>;
