import type {
	ResourceProfiles,
	Resources,
	ServiceSpec,
} from "@logistack/contracts";

/** What an organization starts with until an admin saves its own list. */
export const seededResourceProfiles: ResourceProfiles = {
	profiles: [
		{ name: "Nano", cpu: 0.25, memoryMb: 256 },
		{ name: "Small", cpu: 0.5, memoryMb: 512 },
		{ name: "Medium", cpu: 1, memoryMb: 1024 },
		{ name: "Large", cpu: 2, memoryMb: 4096 },
	],
	defaultProfile: null,
};

const limitsOf = ({ cpu, memoryMb }: Resources): Resources => ({
	...(cpu ? { cpu } : {}),
	...(memoryMb ? { memoryMb } : {}),
});

/**
 * The spec a new service is created with. `choice` names a profile to copy; `null` keeps the
 * spec's resources as sent; omitted, a spec without limits gets the organization default.
 * Compose specs size each service in their overrides and come back unchanged.
 * Throws when `choice` names no profile.
 */
export function applyResourceProfile(
	spec: ServiceSpec,
	choice: string | null | undefined,
	settings: ResourceProfiles,
): ServiceSpec {
	if (spec.kind === "compose" || choice === null) return spec;
	const name =
		choice ??
		(spec.resources.cpu || spec.resources.memoryMb
			? null
			: settings.defaultProfile);
	if (name === null) return spec;
	const profile = settings.profiles.find((p) => p.name === name);
	if (!profile) throw new Error(`no resource profile named ${name}`);
	return { ...spec, resources: limitsOf(profile) };
}
