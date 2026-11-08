import type {
	ApplicationSpec,
	AutoscaleCheck,
	AutoscaleFix,
	AutoscaleFixId,
	ResourceProfile,
	ResourceProfiles,
	Resources,
} from "@logistack/contracts";

/** Peak load of one copy over the last day (p95), or null with too little history. */
export type CopyUsage = { cpu: number; memoryMb: number } | null;

export type FixContext = {
	profiles: ResourceProfiles;
	usage: CopyUsage;
	/** Why a fix can't apply, found outside this module (e.g. a port conflict in the database). */
	blocked?: Partial<Record<AutoscaleFixId, string>>;
};

/** A size must cover the peak by this factor, so a busy minute doesn't hit the limit. */
const HEADROOM = 1.3;

const cores = (n: number) => `${Number(n.toFixed(2))} CPU`;
const mb = (n: number) =>
	n >= 1024 ? `${Number((n / 1024).toFixed(1))} GB` : `${Math.round(n)} MB`;

/**
 * The size to give a service without a CPU limit. Pure. Starts at the org default (else the
 * smallest size) and moves up until a size covers the peak with headroom. A memory limit the
 * user already set is kept and never shrunk; only the CPU limit is added to it.
 */
export function suggestProfile(
	profiles: ResourceProfiles,
	usage: CopyUsage,
	resources: Resources,
):
	| { profile: ResourceProfile; resources: Resources; fits: boolean }
	| undefined {
	const sized = profiles.profiles
		.filter((p): p is ResourceProfile & { cpu: number } => !!p.cpu)
		.sort((a, b) => a.cpu - b.cpu || (a.memoryMb ?? 0) - (b.memoryMb ?? 0));
	if (!sized.length) return undefined;
	const start = Math.max(
		0,
		sized.findIndex((p) => p.name === profiles.defaultProfile),
	);
	const keepMemory = !!resources.memoryMb;
	const covers = (p: ResourceProfile & { cpu: number }) =>
		!usage ||
		(p.cpu >= usage.cpu * HEADROOM &&
			(keepMemory || !p.memoryMb || p.memoryMb >= usage.memoryMb * HEADROOM));
	const found = sized.findIndex((p, i) => i >= start && covers(p));
	const fits = found !== -1;
	const profile = sized[fits ? found : sized.length - 1] as ResourceProfile & {
		cpu: number;
	};
	return {
		profile,
		fits,
		resources: {
			...resources,
			cpu: profile.cpu,
			...(keepMemory || !profile.memoryMb
				? {}
				: { memoryMb: profile.memoryMb }),
		},
	};
}

type Plan = { fix: AutoscaleFix; spec: ApplicationSpec };

const hostPorts = (spec: ApplicationSpec) =>
	spec.ports.filter((p) => p.published && (p.mode ?? "host") === "host");

/**
 * What a fix changes and the spec it produces, or a reason it can't apply. Pure. The modal's
 * preview and the applied patch both come from here, so they can't disagree.
 */
export function planFix(
	id: AutoscaleFixId,
	spec: ApplicationSpec,
	ctx: FixContext,
): Plan | { unavailable: string } {
	const blocked = ctx.blocked?.[id];
	if (blocked) return { unavailable: blocked };
	switch (id) {
		case "apply_profile": {
			const s = suggestProfile(ctx.profiles, ctx.usage, spec.resources);
			if (!s)
				return {
					unavailable:
						"There are no sizes with a CPU limit yet. An admin can add them under Settings → General → Resource profiles.",
				};
			const { profile, resources } = s;
			const changes = [
				{
					label: "CPU limit",
					before: spec.resources.cpu ? cores(spec.resources.cpu) : "None",
					after: `${cores(profile.cpu as number)} (${profile.name})`,
				},
			];
			if (resources.memoryMb !== spec.resources.memoryMb)
				changes.push({
					label: "Memory limit",
					before: spec.resources.memoryMb
						? mb(spec.resources.memoryMb)
						: "None",
					after: resources.memoryMb ? mb(resources.memoryMb) : "None",
				});
			const notes = [
				ctx.usage
					? `Over the last day one copy peaked at ${cores(ctx.usage.cpu)} and ${mb(ctx.usage.memoryMb)}.`
					: `No usage data yet, so this uses ${ctx.profiles.defaultProfile === profile.name ? "your default size" : "the smallest size"}.`,
			];
			if (!s.fits)
				notes.push(
					`Even ${profile.name}, the largest size, is below that peak with headroom. Copies will be added sooner.`,
				);
			if (spec.resources.memoryMb)
				notes.push("The memory limit you set stays as it is.");
			return {
				fix: {
					id,
					title: "Give each copy a size",
					summary: `Applies the ${profile.name} size, so CPU usage can be measured against each copy's limit.`,
					changes,
					notes,
					redeploy: true,
				},
				spec: { ...spec, resources },
			};
		}
		case "ingress_ports": {
			const moved = hostPorts(spec);
			if (!moved.length)
				return { unavailable: "No port is published on a single server." };
			const list = moved.map((p) => p.published).join(", ");
			return {
				fix: {
					id,
					title: "Publish the ports on every server",
					summary:
						"Switches the ports to the routing mesh, so every copy can receive traffic wherever it runs.",
					changes: moved.map((p) => ({
						label: `Port ${p.published}/${p.protocol}`,
						before: "One server",
						after: "Every server",
					})),
					notes: [
						`${moved.length === 1 ? "Port" : "Ports"} ${list} will answer on every server in the cluster, not only on the one the service runs on. Clients keep the same address.`,
						"If your firewall opens the port on one server only, open it on the others too.",
					],
					redeploy: true,
				},
				spec: {
					...spec,
					ports: spec.ports.map((p) =>
						moved.includes(p) ? { ...p, mode: "ingress" as const } : p,
					),
				},
			};
		}
	}
}

const fixOf: Partial<Record<AutoscaleCheck["id"], AutoscaleFixId>> = {
	cpu_limit: "apply_profile",
	host_ports: "ingress_ports",
};

/** Adds the one-click fix (or why it can't apply) and manual links to failed checks. Pure. */
export function attachFixes(
	checks: AutoscaleCheck[],
	spec: ApplicationSpec,
	ctx: FixContext,
): AutoscaleCheck[] {
	return checks.map((c) => {
		if (c.ok) return c;
		if (c.id === "nodes")
			return { ...c, link: { label: "Add a server", to: "/monitoring" } };
		const id = fixOf[c.id];
		if (!id) return c;
		const plan = planFix(id, spec, ctx);
		return "fix" in plan
			? { ...c, fix: plan.fix }
			: { ...c, fixUnavailable: plan.unavailable };
	});
}
