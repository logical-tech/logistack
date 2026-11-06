import {
	deploymentContextVars,
	type PendingChange,
} from "@logistack/contracts";
import type { Mount, PortConfig, ServiceSpec } from "@logistack/docker";
import {
	type CompileServiceInput,
	compileService,
	serviceFiles,
} from "./compile-service.ts";

/**
 * A compiled spec stripped of what differs per run rather than per configuration, plus the env
 * keys whose values may be shown. Recorded on each deployment, recompiled for the pending one.
 */
export type SpecSnapshot = { spec: ServiceSpec; plainEnv: string[] };

/**
 * Pure: the input with Docker object ids replaced by stable names, so the api can compile the
 * same spec the worker would without touching Docker. Desired state is left to start/stop.
 */
export function comparableInput(
	input: CompileServiceInput,
): CompileServiceInput {
	const { scope: _, ...rest } = input;
	const base: CompileServiceInput = {
		...rest,
		service: { ...input.service, desiredState: "running" },
		networks: {
			environment: "environment",
			ingress: "ingress",
			...(input.networks.storage ? { storage: "storage" } : {}),
			...(input.networks.db ? { db: "db" } : {}),
			...(input.networks.game ? { game: "game" } : {}),
		},
		fileIds: {},
	};
	base.fileIds = Object.fromEntries(
		serviceFiles(base).map((f) => [f.name, f.name]),
	);
	return base;
}

export function specSnapshot(
	input: CompileServiceInput,
	env: Record<string, { isSecret: boolean }>,
): SpecSnapshot {
	return {
		spec: compileService(comparableInput(input)),
		plainEnv: Object.keys(env).filter((k) => !env[k]?.isSecret),
	};
}

type Op = "added" | "removed" | "changed";

const same = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

function byKey<T, R>(
	before: readonly T[],
	after: readonly T[],
	key: (t: T) => string,
	emit: (op: Op, b: T | undefined, a: T | undefined) => R,
): R[] {
	const b = new Map(before.map((t) => [key(t), t]));
	const a = new Map(after.map((t) => [key(t), t]));
	const out: R[] = [];
	for (const [k, bv] of b) {
		const av = a.get(k);
		if (av === undefined) out.push(emit("removed", bv, undefined));
		else if (!same(bv, av)) out.push(emit("changed", bv, av));
	}
	for (const [k, av] of a)
		if (!b.has(k)) out.push(emit("added", undefined, av));
	return out;
}

const envEntries = (s: ServiceSpec): [string, string][] =>
	(s.TaskTemplate.ContainerSpec.Env ?? []).map((e) => {
		const i = e.indexOf("=");
		return [e.slice(0, i), e.slice(i + 1)];
	});

const FQDN = "LOGISTACK_FQDN";
const hostnames = (env: [string, string][]) =>
	(env.find(([k]) => k === FQDN)?.[1] ?? "").split(",").filter(Boolean);

function files(s: ServiceSpec) {
	const c = s.TaskTemplate.ContainerSpec;
	return [
		...(c.Configs ?? []).map((f) => ({
			kind: "config" as const,
			target: f.File.Name,
			name: f.ConfigName,
		})),
		...(c.Secrets ?? []).map((f) => ({
			kind: "secret" as const,
			target: f.File.Name,
			name: f.SecretName,
		})),
	];
}

const mountView = (m: Mount) => ({
	type: m.Type,
	source: "Source" in m ? m.Source : null,
	readOnly: "ReadOnly" in m ? (m.ReadOnly ?? false) : false,
});

const portView = (p: PortConfig) => ({
	published: p.PublishedPort ?? null,
	target: p.TargetPort,
	protocol: p.Protocol ?? "tcp",
	mode: p.PublishMode ?? "ingress",
});

const replicas = (s: ServiceSpec) =>
	s.Mode && "Replicated" in s.Mode ? s.Mode.Replicated.Replicas : 0;

/** The spec without the fields `diffSpecs` reads on purpose; what is left is diffed by path. */
function remainder(s: ServiceSpec): unknown {
	const {
		Image: _i,
		Env: _e,
		Mounts: _m,
		Configs: _c,
		Secrets: _s,
		Healthcheck: _h,
		...container
	} = s.TaskTemplate.ContainerSpec;
	const {
		NanoCPUs: _cpu,
		MemoryBytes: _mem,
		...limits
	} = s.TaskTemplate.Resources?.Limits ?? {};
	const { ContainerSpec: _cs, Networks: _n, ...task } = s.TaskTemplate;
	const { Ports: _p, ...endpoint } = s.EndpointSpec ?? {};
	const { Mode: _mode, TaskTemplate: _t, EndpointSpec: _ep, ...top } = s;
	return {
		...top,
		TaskTemplate: {
			...task,
			ContainerSpec: container,
			Resources: { ...task.Resources, Limits: limits },
		},
		EndpointSpec: endpoint,
	};
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function leafDiff(
	b: unknown,
	a: unknown,
	path: string,
	out: PendingChange[],
): void {
	if (isRecord(b) && isRecord(a)) {
		for (const k of new Set([...Object.keys(b), ...Object.keys(a)]))
			leafDiff(b[k], a[k], path ? `${path}.${k}` : k, out);
		return;
	}
	if (!same(b, a))
		out.push({ area: "other", path, before: b ?? null, after: a ?? null });
}

/**
 * Pure: what changes from `before` to `after`. An env value is included only when its key is
 * plain on every side it exists on, or is a deployment context variable; files are compared by
 * content hash.
 */
export function diffSpecs(
	before: SpecSnapshot,
	after: SpecSnapshot,
): PendingChange[] {
	const b = before.spec;
	const a = after.spec;
	const bc = b.TaskTemplate.ContainerSpec;
	const ac = a.TaskTemplate.ContainerSpec;
	const out: PendingChange[] = [];

	if (bc.Image !== ac.Image)
		out.push({ area: "image", before: bc.Image, after: ac.Image });

	const plainBefore = new Set(before.plainEnv);
	const plainAfter = new Set(after.plainEnv);
	const be = envEntries(b);
	const ae = envEntries(a);
	out.push(
		...byKey(
			be.filter(([k]) => k !== FQDN),
			ae.filter(([k]) => k !== FQDN),
			([k]) => k,
			(op, bv, av): PendingChange => {
				const key = (bv ?? av)?.[0] as string;
				// Plain wherever the key exists; anything else, engine-derived env included, is withheld.
				const secret =
					!(key in deploymentContextVars) &&
					((!!bv && !plainBefore.has(key)) || (!!av && !plainAfter.has(key)));
				return {
					area: "env",
					op,
					key,
					secret,
					...(!secret && bv ? { before: bv[1] } : {}),
					...(!secret && av ? { after: av[1] } : {}),
				};
			},
		),
	);
	out.push(
		...byKey(
			hostnames(be),
			hostnames(ae),
			(h) => h,
			(op, bv, av): PendingChange => ({
				area: "domain",
				op: op === "added" ? "added" : "removed",
				hostname: (bv ?? av) as string,
			}),
		),
	);

	const bl = b.TaskTemplate.Resources?.Limits;
	const al = a.TaskTemplate.Resources?.Limits;
	const cpu = (n?: number) => (n ? n / 1e9 : null);
	if (cpu(bl?.NanoCPUs) !== cpu(al?.NanoCPUs))
		out.push({
			area: "resources",
			resource: "cpu",
			before: cpu(bl?.NanoCPUs),
			after: cpu(al?.NanoCPUs),
		});
	if ((bl?.MemoryBytes ?? null) !== (al?.MemoryBytes ?? null))
		out.push({
			area: "resources",
			resource: "memory",
			before: bl?.MemoryBytes ?? null,
			after: al?.MemoryBytes ?? null,
		});

	if (replicas(b) !== replicas(a))
		out.push({ area: "replicas", before: replicas(b), after: replicas(a) });

	out.push(
		...byKey(
			(bc.Mounts ?? []).map((m) => ({ target: m.Target, view: mountView(m) })),
			(ac.Mounts ?? []).map((m) => ({ target: m.Target, view: mountView(m) })),
			(m) => m.target,
			(op, bv, av): PendingChange => ({
				area: "mount",
				op,
				target: (bv ?? av)?.target as string,
				...(bv ? { before: bv.view } : {}),
				...(av ? { after: av.view } : {}),
			}),
		),
	);
	out.push(
		...byKey(
			files(b),
			files(a),
			(f) => `${f.kind}:${f.target}`,
			(op, bv, av): PendingChange => {
				const f = (bv ?? av) as ReturnType<typeof files>[number];
				return { area: "file", op, target: f.target, kind: f.kind };
			},
		),
	);
	out.push(
		...byKey(
			(b.EndpointSpec?.Ports ?? []).map(portView),
			(a.EndpointSpec?.Ports ?? []).map(portView),
			(p) => `${p.published}/${p.protocol}`,
			(op, bv, av): PendingChange => ({
				area: "port",
				op,
				...(bv ? { before: bv } : {}),
				...(av ? { after: av } : {}),
			}),
		),
	);
	if (!same(bc.Healthcheck, ac.Healthcheck))
		out.push({
			area: "healthcheck",
			before: bc.Healthcheck?.Test ?? null,
			after: ac.Healthcheck?.Test ?? null,
		});
	out.push(
		...byKey(
			b.TaskTemplate.Networks ?? [],
			a.TaskTemplate.Networks ?? [],
			(n) => n.Target,
			(op, bv, av): PendingChange => ({
				area: "network",
				op,
				network: (bv ?? av)?.Target as string,
			}),
		),
	);
	leafDiff(remainder(b), remainder(a), "", out);
	return out;
}

const MB = 1024 * 1024;
const memory = (bytes: number | null) =>
	bytes === null
		? "unlimited"
		: bytes % (1024 * MB) === 0
			? `${bytes / (1024 * MB)} GB`
			: `${Math.round(bytes / MB)} MB`;
const cores = (n: number | null) =>
	n === null ? "unlimited" : `${n} ${n === 1 ? "core" : "cores"}`;

const otherLabels: Record<string, string> = {
	"TaskTemplate.ContainerSpec.Command": "entrypoint",
	"TaskTemplate.ContainerSpec.Args": "command",
	"TaskTemplate.ContainerSpec.User": "user",
	"TaskTemplate.ContainerSpec.CapabilityAdd": "added capabilities",
	"TaskTemplate.ContainerSpec.CapabilityDrop": "dropped capabilities",
	"TaskTemplate.Placement.Constraints": "placement constraints",
	"TaskTemplate.Placement.Platforms": "image platforms",
	"TaskTemplate.RestartPolicy.Condition": "restart policy",
	"TaskTemplate.ContainerSpec.StopGracePeriod": "drain timeout",
	"UpdateConfig.Order": "update order",
	"RollbackConfig.Order": "rollback order",
};

const portLabel = (p: { published: number | null; protocol: string }) =>
	`port ${p.published}/${p.protocol}`;

/** Pure: one line a person reads, such as "memory limit 512 MB → 1 GB". Never a secret value. */
export function summarizeChange(c: PendingChange): string {
	switch (c.area) {
		case "image":
			return `image ${c.before} → ${c.after}`;
		case "env":
			return `env var ${c.key} ${c.op}`;
		case "domain":
			return `domain ${c.hostname} ${c.op}`;
		case "resources":
			return c.resource === "memory"
				? `memory limit ${memory(c.before)} → ${memory(c.after)}`
				: `CPU limit ${cores(c.before)} → ${cores(c.after)}`;
		case "replicas":
			return `replicas ${c.before} → ${c.after}`;
		case "mount": {
			const type = (c.after ?? c.before)?.type ?? "";
			return `${type} mount ${c.target} ${c.op}`;
		}
		case "file":
			return `${c.kind} file ${c.target} ${c.op}`;
		case "port": {
			const p = (c.after ?? c.before) as NonNullable<typeof c.after>;
			if (c.op !== "changed") return `${portLabel(p)} ${c.op}`;
			return `${portLabel(p)} now targets ${c.after?.target} (${c.after?.mode})`;
		}
		case "healthcheck":
			return `healthcheck ${c.before === null ? "added" : c.after === null ? "removed" : "changed"}`;
		case "network":
			return `${c.network} network ${c.op}`;
		case "other":
			return `${otherLabels[c.path] ?? c.path} changed`;
	}
}
