import {
	backupKey,
	domainKey,
	type ManifestBackup,
	type ManifestChange,
	type ManifestDomain,
	type ManifestEnvironment,
	type ManifestService,
	type ManifestStack,
	type ManifestVariable,
	type ProjectManifest,
	type ServiceSpec,
} from "@logistack/contracts";
import { databaseCredentials } from "./database-credentials.ts";
import { gameCredentials } from "./game.ts";
import { storageCredentials } from "./storage.ts";

type Step<R extends ManifestChange["resource"], T> = Omit<
	ManifestChange,
	"resource"
> & {
	resource: R;
	/** The manifest's version; absent for a delete. */
	want?: T;
	/** What is there now; absent for a create. */
	have?: T;
};

/** A plan entry with what the executor needs to carry it out. */
export type ManifestStep =
	| Step<"project", ProjectManifest["project"]>
	| Step<"environment", ManifestEnvironment>
	| Step<"variable", ManifestVariable>
	| Step<"stack", ManifestStack>
	| Step<"service", ManifestService>
	| Step<"domain", ManifestDomain>
	| Step<"backup", ManifestBackup>;

export type ManifestPlan = { steps: ManifestStep[]; warnings: string[] };

/** The order apply converges in: each phase can rely on the ones before it. */
export const manifestPhases = [
	"project",
	"environment",
	"variable",
	"stack",
	"service",
	"domain",
	"backup",
] as const satisfies readonly ManifestChange["resource"][];

/** Key order and absent fields never count as a difference. */
function canon(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(canon);
	if (v && typeof v === "object")
		return Object.fromEntries(
			Object.entries(v)
				.filter(([, x]) => x !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, x]) => [k, canon(x)]),
		);
	return v;
}
const same = (a: unknown, b: unknown) =>
	JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Top-level fields of two objects that differ. */
const changedFields = <T extends object>(a: T, b: T) =>
	[...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
		(k) => !same(a[k as keyof T], b[k as keyof T]),
	);

/** A secret in the manifest without a value means "keep the stored one". */
function variableChanges(have: ManifestVariable, want: ManifestVariable) {
	const lines: string[] = [];
	if (want.value !== undefined && want.value !== have.value)
		lines.push("value changed");
	if (want.secret !== have.secret)
		lines.push(want.secret ? "now secret" : "no longer secret");
	if (want.buildTime !== have.buildTime)
		lines.push(want.buildTime ? "now build time" : "no longer build time");
	return lines;
}

/** Env keys a new service gets without being told: its minted credentials. */
const mintedKeys = (spec: ServiceSpec) =>
	Object.keys(
		spec.kind === "database"
			? databaseCredentials(spec.engine)
			: spec.kind === "storage"
				? storageCredentials(spec.engine)
				: spec.kind === "game"
					? gameCredentials(spec.settings)
					: {},
	);

/**
 * Pure: the service-scope variables `PUT /services/{id}/env-vars` should get, and whether that
 * differs from `have`. Without `prune` a key the manifest does not list is kept. A secret with no
 * value that does not exist yet cannot be written and is left out.
 */
export function serviceVariables(
	have: readonly ManifestVariable[],
	want: readonly ManifestVariable[],
	prune: boolean,
) {
	const stored = new Map(have.map((v) => [v.key, v]));
	const listed = new Set(want.map((v) => v.key));
	const lines: string[] = [];
	const body: {
		key: string;
		value?: string;
		isSecret: boolean;
		isBuildTime: boolean;
	}[] = [];
	for (const v of want) {
		const prev = stored.get(v.key);
		if (!prev && v.value === undefined) continue;
		const diff = prev ? variableChanges(prev, v) : ["added"];
		if (diff.length) lines.push(`variable ${v.key} ${diff.join(", ")}`);
		body.push({
			key: v.key,
			...(v.value !== undefined && { value: v.value }),
			isSecret: v.secret,
			isBuildTime: v.buildTime,
		});
	}
	for (const v of have)
		if (!listed.has(v.key)) {
			if (prune) lines.push(`variable ${v.key} removed`);
			else
				body.push({
					key: v.key,
					isSecret: v.secret,
					isBuildTime: v.buildTime,
				});
		}
	return { body, lines };
}

/** Pure: config files whose content differs, by target. */
export const changedConfigs = (have: ManifestService, want: ManifestService) =>
	want.mounts.filter(
		(m) =>
			m.kind === "config" &&
			have.mounts.some(
				(h) => h.kind === "config" && h.target === m.target && !same(h, m),
			),
	);

/** Pure: fields `PATCH /services/{id}` sets that differ; an icon the manifest leaves out is not compared. */
export function changedServiceFields(
	have: ManifestService,
	want: ManifestService,
) {
	const pick = (s: ManifestService) => ({
		name: s.name,
		icon: want.icon === undefined ? undefined : s.icon,
		desiredState: s.desiredState,
		spec: s.spec,
		gitProvider: s.gitProvider,
	});
	return changedFields(pick(have), pick(want));
}

type Ctx = {
	prune: boolean;
	/** Slug of the environment the steps belong to; absent at project level. */
	environment?: string;
	steps: ManifestStep[];
	warnings: string[];
};

/** Creates, updates and (with prune) deletes of one keyed list. */
function diffList<T, R extends ManifestStep["resource"]>(
	ctx: Ctx,
	resource: R,
	have: readonly T[],
	want: readonly T[],
	key: (t: T) => string,
	compare: (have: T, want: T) => string[],
	extra: Partial<ManifestChange> = {},
	created: (want: T) => string[] = () => ["new"],
) {
	const stored = new Map(have.map((t) => [key(t), t]));
	const listed = new Set(want.map(key));
	const push = (s: Omit<Step<R, T>, "resource" | "environment">) =>
		ctx.steps.push({
			resource,
			environment: ctx.environment,
			...extra,
			...s,
		} as ManifestStep);
	for (const w of want) {
		const h = stored.get(key(w));
		if (!h) {
			push({ op: "create", name: key(w), want: w, changes: created(w) });
			continue;
		}
		const changes = compare(h, w);
		if (changes.length)
			push({ op: "update", name: key(w), want: w, have: h, changes });
	}
	if (ctx.prune)
		for (const h of have)
			if (!listed.has(key(h)))
				push({ op: "delete", name: key(h), have: h, changes: ["removed"] });
}

function planVariables(
	ctx: Ctx,
	have: readonly ManifestVariable[],
	want: readonly ManifestVariable[],
	where: string,
) {
	const stored = new Set(have.map((v) => v.key));
	const missing = want.filter(
		(v) => v.value === undefined && !stored.has(v.key),
	);
	for (const v of missing)
		ctx.warnings.push(
			`${where}: secret ${v.key} has no value in the manifest; set it after applying`,
		);
	diffList(
		ctx,
		"variable",
		have,
		want.filter((v) => !missing.includes(v)),
		(v) => v.key,
		variableChanges,
		{},
		(v) => [v.secret ? "new secret" : "new"],
	);
}

/** Whether apply must save the manifest's autoscaling; a preset's own CPU target is not a change. */
export function autoscaleChanged(have: ManifestService, want: ManifestService) {
	if (!want.autoscale) return false;
	const norm = (a: ManifestService["autoscale"]) =>
		a && {
			...a,
			targetCpu: a.behavior === "custom" ? a.targetCpu : undefined,
		};
	return !same(norm(have.autoscale), norm(want.autoscale));
}

function serviceChanges(
	ctx: Ctx,
	have: ManifestService,
	want: ManifestService,
) {
	const lines: string[] = [];
	for (const k of changedServiceFields(have, want))
		if (k === "spec")
			for (const f of changedFields(have.spec, want.spec))
				lines.push(`spec.${f} changed`);
		else lines.push(`${k} changed`);
	if (autoscaleChanged(have, want)) lines.push("autoscale changed");
	lines.push(
		...serviceVariables(have.variables, want.variables, ctx.prune).lines,
	);
	for (const v of want.variables)
		if (v.value === undefined && !have.variables.some((h) => h.key === v.key))
			ctx.warnings.push(
				`${ctx.environment}/${want.slug}: secret ${v.key} has no value in the manifest; set it after applying`,
			);
	for (const m of changedConfigs(have, want))
		lines.push(`file ${m.target} changed`);
	const mountTargets = (s: ManifestService) =>
		new Map(s.mounts.map((m) => [m.target, m]));
	const before = mountTargets(have);
	const after = mountTargets(want);
	for (const [target, m] of after) {
		const h = before.get(target);
		if (!h || h.kind !== m.kind || (m.kind === "volume" && !same(h, m)))
			ctx.warnings.push(
				`${ctx.environment}/${want.slug}: mount ${target} cannot change on an existing service; recreate the service to change its volumes`,
			);
	}
	if (ctx.prune)
		for (const target of before.keys())
			if (!after.has(target))
				ctx.warnings.push(
					`${ctx.environment}/${want.slug}: mount ${target} is kept; mounts cannot be removed from an existing service`,
				);
	return lines;
}

function serviceCreated(ctx: Ctx, want: ManifestService) {
	if (want.stack) return [`created by stack ${want.stack}`];
	const minted = new Set(mintedKeys(want.spec));
	for (const v of want.variables)
		if (v.value === undefined && !minted.has(v.key))
			ctx.warnings.push(
				`${ctx.environment}/${want.slug}: secret ${v.key} has no value in the manifest; set it after applying`,
			);
	return [`new ${want.spec.kind}`];
}

const compareFields = <T extends object>(have: T, want: T) =>
	changedFields(have, want).map((k) => `${k} changed`);

function compareBackup(ctx: Ctx, service: string) {
	return (have: ManifestBackup, want: ManifestBackup) => {
		if (have.encrypt && !want.encrypt) {
			ctx.warnings.push(
				`${ctx.environment}/${service}: backup ${backupKey(want)} stays encrypted; encryption cannot be turned off`,
			);
			return compareFields(
				{ ...have, encrypt: true },
				{ ...want, encrypt: true },
			);
		}
		return compareFields(have, want);
	};
}

/**
 * Pure: what applying `want` to the environment `have` creates, updates and, with `prune`, deletes.
 * Applying an environment's own export changes nothing. Secret values in `have` are only compared,
 * never written into the plan.
 */
export function planEnvironment(
	have: ManifestEnvironment | undefined,
	want: ManifestEnvironment,
	prune: boolean,
): ManifestPlan {
	const plan: ManifestPlan = { steps: [], warnings: [] };
	planInto(plan, have, want, prune);
	return ordered(plan);
}

const ordered = (plan: ManifestPlan): ManifestPlan => ({
	steps: plan.steps.sort(
		(a, b) =>
			manifestPhases.indexOf(a.resource) - manifestPhases.indexOf(b.resource),
	),
	warnings: [...new Set(plan.warnings)],
});

function planInto(
	plan: ManifestPlan,
	have: ManifestEnvironment | undefined,
	want: ManifestEnvironment,
	prune: boolean,
) {
	const environment = have?.slug ?? want.slug;
	const ctx: Ctx = { prune, environment, ...plan };
	planVariables(ctx, have?.variables ?? [], want.variables, environment);
	diffList(
		ctx,
		"stack",
		have?.stacks ?? [],
		want.stacks,
		(s) => s.name,
		(h, w) => {
			if (same(h, w)) return [];
			ctx.warnings.push(
				`${ctx.environment}: stack ${w.name} changes its git source; apply does not move a stack, change it in the stack's settings`,
			);
			return [];
		},
	);
	const services = new Map((have?.services ?? []).map((s) => [s.slug, s]));
	diffList(
		ctx,
		"service",
		have?.services ?? [],
		want.services,
		(s) => s.slug,
		(h, w) => serviceChanges(ctx, h, w),
		{},
		(w) => serviceCreated(ctx, w),
	);
	for (const w of want.services) {
		const h = services.get(w.slug);
		const extra = { service: w.slug };
		diffList(
			ctx,
			"domain",
			h?.domains ?? [],
			w.domains,
			domainKey,
			compareFields,
			extra,
		);
		diffList(
			ctx,
			"backup",
			h?.backups ?? [],
			w.backups,
			backupKey,
			compareBackup(ctx, w.slug),
			extra,
		);
	}
}

/** Pure: `planEnvironment` for every environment of a project, plus the project itself. */
export function planProject(
	have: ProjectManifest,
	want: ProjectManifest,
	prune: boolean,
): ManifestPlan {
	const plan: ManifestPlan = { steps: [], warnings: [] };
	const ctx: Ctx = { prune, ...plan };
	if (!same(have.project, want.project))
		plan.steps.push({
			op: "update",
			resource: "project",
			name: want.project.name,
			want: want.project,
			have: have.project,
			changes: compareFields(have.project, want.project),
		});
	planVariables(ctx, have.variables, want.variables, "project");
	const meta = (e: ManifestEnvironment) => ({
		name: e.name,
		kind: e.kind,
		color: e.color,
	});
	diffList(
		ctx,
		"environment",
		have.environments,
		want.environments,
		(e) => e.slug,
		(h, w) => compareFields(meta(h), meta(w)),
		{},
		(w) => [`new ${w.kind} environment`],
	);
	const envs = new Map(have.environments.map((e) => [e.slug, e]));
	for (const w of want.environments) planInto(plan, envs.get(w.slug), w, prune);
	return ordered(plan);
}
