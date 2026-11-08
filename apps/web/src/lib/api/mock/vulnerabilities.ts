import type {
	Finding,
	VulnerabilitiesApi,
	VulnerabilitiesView,
} from "../vulnerabilities";

const delay = <T>(v: T) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 250));

const nvd = (id: string) => `https://avd.aquasec.com/nvd/${id.toLowerCase()}`;

const findings: Finding[] = [
	{
		id: "CVE-2025-49794",
		severity: "critical",
		pkgName: "libxml2",
		installedVersion: "2.13.4-r5",
		fixedVersion: "2.13.9-r0",
		title: "libxml2: heap use after free leads to denial of service",
		url: nvd("CVE-2025-49794"),
	},
	{
		id: "CVE-2025-6965",
		severity: "high",
		pkgName: "sqlite-libs",
		installedVersion: "3.48.0-r1",
		fixedVersion: "3.48.0-r4",
		title: "sqlite: integer truncation in aggregate queries",
		url: nvd("CVE-2025-6965"),
	},
	{
		id: "CVE-2025-9230",
		severity: "medium",
		pkgName: "openssl",
		installedVersion: "3.3.3-r0",
		fixedVersion: "3.3.5-r0",
		title: "openssl: out-of-bounds read in CMS password-based decryption",
		url: nvd("CVE-2025-9230"),
	},
	{
		id: "CVE-2024-58251",
		severity: "low",
		pkgName: "busybox",
		installedVersion: "1.37.0-r12",
		fixedVersion: null,
		title: "busybox: netstat escape sequences in local socket names",
		url: nvd("CVE-2024-58251"),
	},
];

const counts = { critical: 1, high: 1, medium: 1, low: 1, unknown: 0 };

const scanned: VulnerabilitiesView = {
	image: "ghcr.io/acme/storefront",
	digest:
		"sha256:9f3c1e0b7a24d5f8c6e2a1b0d9c8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0",
	status: "succeeded",
	badge: "critical",
	counts,
	scannedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
	error: null,
	findings,
} as unknown as VulnerabilitiesView;

const state = new Map<string, VulnerabilitiesView>();

export const mockVulnerabilities: VulnerabilitiesApi = {
	get: (id) => delay(state.get(id) ?? scanned),
	scan: (id) => {
		const view = state.get(id) ?? scanned;
		state.set(id, { ...view, status: "running" });
		setTimeout(
			() =>
				state.set(id, {
					...view,
					status: "succeeded",
					scannedAt: new Date().toISOString(),
				} as VulnerabilitiesView),
			4_000,
		);
		return delay(view);
	},
};
