import type { ServiceSpec } from "@logistack/contracts";
import type {
	TemplateEnvEntry,
	TemplateMount,
	TemplateServicePlan,
} from "./template.ts";

/** Top-level spec fields a compose edit sets or clears; fields it never mentioned keep their value. */
export type SpecPatch = { set: Record<string, unknown>; unset: string[] };

export type StackDelta =
	| { op: "create"; name: string; plan: TemplateServicePlan; changes: string[] }
	| {
			op: "update";
			name: string;
			plan: TemplateServicePlan;
			spec: SpecPatch;
			env: { set: TemplateEnvEntry[]; remove: string[] };
			/** Keyed by target. */
			mounts: { set: TemplateMount[]; remove: string[] };
			changes: string[];
	  }
	| { op: "remove"; name: string; changes: string[] };

export class StackUpdateError extends Error {}

const same = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

function byKey<T>(
	before: readonly T[],
	after: readonly T[],
	key: (t: T) => string,
) {
	const b = new Map(before.map((t) => [key(t), t]));
	const set = after.filter((t) => !same(b.get(key(t)), t));
	const keep = new Set(after.map(key));
	const remove = [...b.keys()].filter((k) => !keep.has(k));
	return { set, remove };
}

const imageOf = (spec: ServiceSpec) =>
	spec.kind === "application" && spec.source.type === "image"
		? spec.source.image
		: spec.kind === "database"
			? `${spec.engine}:${spec.version}`
			: undefined;

function specPatch(
	before: ServiceSpec | undefined,
	after: ServiceSpec,
): SpecPatch {
	const b = (before ?? {}) as Record<string, unknown>;
	const a = after as Record<string, unknown>;
	const set: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(a)) if (!same(b[k], v)) set[k] = v;
	// A source and its build type are only valid together.
	if ("source" in set || "build" in set) {
		set.source = a.source;
		set.build = a.build;
	}
	return { set, unset: Object.keys(b).filter((k) => !(k in a)) };
}

/**
 * Pure: what applying the compose `after` does to a stack whose last applied compose was `before`
 * and whose services are `existing`. Three-way: only what the compose itself changed is written,
 * so edits made on a service since (an env var, resources) survive. A compose service with no
 * service yet is created, also when it was deleted by hand; a service the compose dropped is
 * removed. Throws StackUpdateError when a service changes kind.
 */
export function diffStack(
	before: readonly TemplateServicePlan[],
	after: readonly TemplateServicePlan[],
	existing: ReadonlyMap<string, { kind: ServiceSpec["kind"] }>,
): StackDelta[] {
	const old = new Map(before.map((p) => [p.name, p]));
	const next = new Set(after.map((p) => p.name));
	const out: StackDelta[] = [];
	for (const plan of after) {
		const current = existing.get(plan.name);
		if (!current) {
			const image = imageOf(plan.spec);
			out.push({
				op: "create",
				name: plan.name,
				plan,
				changes: [`new ${plan.spec.kind}${image ? ` from ${image}` : ""}`],
			});
			continue;
		}
		if (current.kind !== plan.spec.kind)
			throw new StackUpdateError(
				`${plan.name} would change from ${current.kind} to ${plan.spec.kind}; give it a new name to replace it`,
			);
		const prev = old.get(plan.name);
		const spec = specPatch(prev?.spec, plan.spec);
		const env = byKey(prev?.env ?? [], plan.env, (e) => e.key);
		const mounts = byKey(prev?.mounts ?? [], plan.mounts, (m) => m.target);
		const changes: string[] = [];
		const imageBefore = prev && imageOf(prev.spec);
		const imageAfter = imageOf(plan.spec);
		const prevSpec = (prev?.spec ?? {}) as Record<string, unknown>;
		for (const [k, v] of Object.entries(spec.set))
			if (!same(prevSpec[k], v))
				changes.push(
					(k === "source" || k === "version") && imageBefore !== imageAfter
						? `image ${imageBefore ?? "?"} → ${imageAfter ?? "a build"}`
						: `${k} changed`,
				);
		for (const k of spec.unset) changes.push(`${k} removed`);
		const prevEnv = new Set(prev?.env.map((e) => e.key));
		for (const e of env.set)
			changes.push(`env ${e.key} ${prevEnv.has(e.key) ? "changed" : "added"}`);
		for (const k of env.remove) changes.push(`env ${k} removed`);
		const prevMounts = new Set(prev?.mounts.map((m) => m.target));
		for (const m of mounts.set)
			changes.push(
				`${m.kind === "volume" ? "volume" : "file"} ${m.target} ${prevMounts.has(m.target) ? "changed" : "added"}`,
			);
		for (const t of mounts.remove) changes.push(`mount ${t} removed`);
		if (changes.length)
			out.push({
				op: "update",
				name: plan.name,
				plan,
				spec,
				env,
				mounts,
				changes: [...new Set(changes)],
			});
	}
	for (const p of before)
		if (!next.has(p.name) && existing.has(p.name))
			out.push({
				op: "remove",
				name: p.name,
				changes: ["removed; its volumes are kept"],
			});
	return out;
}

/** Pure: `spec` with a compose edit's patch applied. */
export function patchSpec<T extends ServiceSpec>(spec: T, patch: SpecPatch): T {
	const out: Record<string, unknown> = { ...spec, ...patch.set };
	for (const k of patch.unset) delete out[k];
	return out as T;
}
