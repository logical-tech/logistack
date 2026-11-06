import {
	Hostname,
	type ManifestDomain,
	type ManifestEnvironment,
	type ManifestService,
} from "@logistack/contracts";

export const previewSlug = (number: number) => `pr-${number}`;

/** Pure: the host `pattern` gives `service` of pull request `number`; null when that is not a single hostname. */
export function previewHostname(
	pattern: string,
	t: { number: number; service: string; wildcard?: string | null },
): string | null {
	if (pattern.includes("{wildcard}") && !t.wildcard) return null;
	const host = pattern
		.replaceAll("{number}", String(t.number))
		.replaceAll("{service}", t.service)
		.replaceAll("{wildcard}", t.wildcard ?? "");
	return !host.startsWith("*.") && Hostname.safeParse(host).success
		? host
		: null;
}

export type PreviewInput = {
	number: number;
	headBranch: string;
	/** Slugs of the git services that build the pull request's branch. */
	follow: readonly string[];
	/** Overrides, decrypted. */
	variables: readonly { key: string; value: string; secret: boolean }[];
	domainPattern: string | null;
	/** The instance's custom wildcard without its `*.`, for `{wildcard}`. */
	wildcard?: string | null;
};

/**
 * Pure: the environment a pull request's preview converges to, from the source environment's
 * manifest. Same services, stacks and variables; the followed services build the pull request's
 * branch; overrides win over every source definition of their key; no backups; one domain per
 * service the source exposes, from the pattern. `generated` lists the services left without a
 * host (no pattern, an unusable one, or a host another service took), which get a generated one.
 * Volumes and databases are never shared: apply creates new services, and Docker names derive
 * from their new ids.
 */
export function previewEnvironment(
	source: ManifestEnvironment,
	input: PreviewInput,
): {
	environment: ManifestEnvironment;
	generated: { service: string; port: number }[];
} {
	const overridden = new Set(input.variables.map((v) => v.key));
	const keep = <T extends { key: string }>(vars: readonly T[]) =>
		vars.filter((v) => !overridden.has(v.key));
	const buildTime = new Set(
		[...source.variables, ...source.services.flatMap((s) => s.variables)]
			.filter((v) => v.buildTime)
			.map((v) => v.key),
	);
	const taken = new Set<string>();
	const generated: { service: string; port: number }[] = [];
	const services = source.services.map((s): ManifestService => {
		const spec = structuredClone(s.spec);
		if (
			input.follow.includes(s.slug) &&
			"source" in spec &&
			spec.source.type === "git"
		)
			spec.source.branch = input.headBranch;
		const exposed = s.domains.find((d) => !d.redirectTo);
		const host =
			exposed && input.domainPattern
				? previewHostname(input.domainPattern, {
						number: input.number,
						service: s.slug,
						wildcard: input.wildcard,
					})
				: null;
		const domains: ManifestDomain[] = [];
		if (exposed && host && !taken.has(host)) {
			taken.add(host);
			domains.push({
				hostname: host,
				port: exposed.port,
				https: true,
				cert: "auto",
				tunnel: false,
			});
		} else if (exposed) generated.push({ service: s.slug, port: exposed.port });
		return {
			...s,
			spec,
			variables: keep(s.variables),
			domains,
			backups: [],
		};
	});
	return {
		environment: {
			name: `PR #${input.number}`,
			slug: previewSlug(input.number),
			kind: "preview",
			variables: [
				...keep(source.variables),
				...input.variables.map((v) => ({
					key: v.key,
					value: v.value,
					secret: v.secret,
					buildTime: buildTime.has(v.key),
				})),
			],
			stacks: source.stacks,
			services,
		},
		generated,
	};
}
