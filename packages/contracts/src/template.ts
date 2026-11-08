/**
 * LogiStack template schema v1: a declarative recipe that deploys one or more services
 * into an environment. Generated values are typed inputs, never magic env names; env
 * values reference them with `${{ inputs.<key> }}` and sibling services with
 * `${{ services.<name>.host }}`.
 */
import { z } from "zod";
import { DatabaseEngine } from "./enums.ts";
import {
	EnvKey,
	isReservedEnvKey,
	reservedEnvKeyMessage,
} from "./resources.ts";
import {
	Capability,
	Healthcheck,
	PortMapping,
	Resources,
	RestartCondition,
} from "./service-spec.ts";

export const templateCategories = [
	"ai",
	"analytics",
	"automation",
	"cms",
	"communication",
	"database",
	"devtools",
	"finance",
	"media",
	"monitoring",
	"networking",
	"productivity",
	"security",
	"storage",
	"other",
] as const;
export const TemplateCategory = z.enum(templateCategories);
export type TemplateCategory = z.infer<typeof TemplateCategory>;

/** A DNS label: the service's slug, and its alias on the environment network. */
export const TemplateServiceName = z
	.string()
	.max(63)
	.regex(
		/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
		"lowercase letters, digits, dashes",
	);

export const InputKey = z
	.string()
	.max(64)
	.regex(/^[a-z][A-Za-z0-9]*$/, "camelCase letters and digits");

const inputBase = {
	key: InputKey,
	label: z.string().min(1).max(100),
	description: z.string().max(500).optional(),
};

/** Generated server-side when the caller leaves them empty. */
export const generatedInputTypes = [
	"password",
	"secret",
	"username",
	"base64",
	"uuid",
] as const;

export const TemplateInput = z.discriminatedUnion("type", [
	/** Free text; required unless it has a default. */
	z.object({
		...inputBase,
		type: z.literal("text"),
		default: z.string().optional(),
	}),
	/** A credential a human may type: letters and digits. */
	z.object({
		...inputBase,
		type: z.literal("password"),
		length: z.int().min(8).max(128).default(32),
	}),
	/** A machine key. */
	z.object({
		...inputBase,
		type: z.literal("secret"),
		length: z.int().min(8).max(256),
		charset: z.enum(["alnum", "hex"]).default("alnum"),
	}),
	z.object({
		...inputBase,
		type: z.literal("username"),
		default: z.string().optional(),
	}),
	/** Base64 of `bytes` random bytes. */
	z.object({
		...inputBase,
		type: z.literal("base64"),
		bytes: z.int().min(8).max(256),
	}),
	z.object({ ...inputBase, type: z.literal("uuid") }),
	/** A hostname; empty means a generated one. `primary` is the URL the template is opened at. */
	z.object({
		...inputBase,
		type: z.literal("domain"),
		role: z.enum(["primary", "extra"]),
	}),
]);
export type TemplateInput = z.infer<typeof TemplateInput>;
export type TemplateInputType = TemplateInput["type"];

/** Inputs whose values are stored as secret env vars. */
export const secretInputTypes: readonly TemplateInputType[] = [
	"password",
	"secret",
	"base64",
];

/** `${{ inputs.key }}` or `${{ services.name.host }}`; anything else in a value is literal. */
export const TEMPLATE_EXPRESSION =
	/\$\{\{\s*(?:inputs\.([a-z][A-Za-z0-9]*)|services\.([a-z0-9-]+)\.host)\s*\}\}/g;

export type TemplateRef =
	| { kind: "input"; key: string }
	| { kind: "service"; name: string };

export function templateRefs(value: string): TemplateRef[] {
	return [...value.matchAll(TEMPLATE_EXPRESSION)].map((m) =>
		m[1]
			? { kind: "input", key: m[1] }
			: { kind: "service", name: m[2] as string },
	);
}

export const floatingTags = new Set([
	"latest",
	"stable",
	"main",
	"master",
	"nightly",
	"edge",
]);

/** `repo:tag` or `repo@sha256:...`; floating tags and interpolation are refused. */
export const PinnedImage = z
	.string()
	.min(1)
	.refine(
		(img) => {
			if (img.includes("$")) return false;
			if (/@sha256:[a-f0-9]{64}$/.test(img)) return true;
			const last = img.slice(img.lastIndexOf("/") + 1);
			const colon = last.lastIndexOf(":");
			return colon > 0 && !floatingTags.has(last.slice(colon + 1));
		},
		{ message: "image must be pinned to a version tag or a digest" },
	);

const AbsoluteTarget = z
	.string()
	.regex(/^\/[^\0]*$/, "must be an absolute path")
	.refine((p) => !p.split("/").includes(".."), "must not contain '..'");

export const TemplateVolume = z.object({
	name: TemplateServiceName,
	target: AbsoluteTarget,
	readOnly: z.boolean().optional(),
});

/** A file written into the container; `secret` stores it as a Swarm secret. */
export const TemplateFile = z.object({
	target: AbsoluteTarget,
	content: z.string(),
	secret: z.boolean().optional(),
});

const serviceBase = {
	name: TemplateServiceName,
	dependsOn: z.array(TemplateServiceName).default([]),
	env: z
		.record(EnvKey, z.string())
		.superRefine((env, ctx) => {
			for (const key of Object.keys(env).filter(isReservedEnvKey))
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: reservedEnvKeyMessage(key),
				});
		})
		.default({}),
	volumes: z.array(TemplateVolume).default([]),
	files: z.array(TemplateFile).default([]),
};

export const TemplateApplication = z.object({
	...serviceBase,
	kind: z.literal("application"),
	image: PinnedImage,
	/** argv, never a shell string. */
	command: z.array(z.string()).optional(),
	entrypoint: z.array(z.string()).optional(),
	ports: z.array(PortMapping).default([]),
	healthcheck: Healthcheck.optional(),
	/** Routed through the proxy on `port`, at the hostname of the `domain` input. */
	public: z
		.object({ port: z.int().min(1).max(65535), domain: InputKey })
		.optional(),
	user: z
		.string()
		.regex(/^\d+(:\d+)?$/)
		.optional(),
	capAdd: z.array(Capability).optional(),
	capDrop: z.array(Capability).optional(),
	restart: RestartCondition.optional(),
	/** Seconds after SIGTERM, from compose `stop_grace_period`. */
	drainTimeout: z.int().min(0).max(3600).optional(),
	resources: Resources.optional(),
});
export type TemplateApplication = z.infer<typeof TemplateApplication>;

export const TemplateDatabase = z.object({
	...serviceBase,
	kind: z.literal("database"),
	engine: DatabaseEngine,
	/** The official image's tag. */
	version: z
		.string()
		.min(1)
		.refine((v) => !floatingTags.has(v), "version must be pinned"),
});
export type TemplateDatabase = z.infer<typeof TemplateDatabase>;

export const TemplateService = z.discriminatedUnion("kind", [
	TemplateApplication,
	TemplateDatabase,
]);
export type TemplateService = z.infer<typeof TemplateService>;

export const TemplateSource = z.object({
	kind: z.enum(["coolify", "dokploy"]),
	/** Path inside the upstream repository, for attribution. */
	path: z.string().min(1),
	license: z.string().min(1),
});

export const TemplateId = TemplateServiceName;

/** Every ordering problem in `dependsOn`, or [] when it is a DAG over known services. */
function dependencyIssues(services: TemplateService[]): string[] {
	const names = new Set(services.map((s) => s.name));
	const issues: string[] = [];
	for (const s of services)
		for (const d of s.dependsOn)
			if (!names.has(d))
				issues.push(`${s.name} depends on unknown service ${d}`);
	if (issues.length) return issues;
	try {
		dependencyOrder(services);
	} catch (e) {
		issues.push((e as Error).message);
	}
	return issues;
}

/** Services ordered so each comes after what it depends on; throws on a cycle. */
export function dependencyOrder<
	S extends { name: string; dependsOn: string[] },
>(services: S[]): S[] {
	const byName = new Map(services.map((s) => [s.name, s]));
	const done = new Set<string>();
	const visiting = new Set<string>();
	const out: S[] = [];
	const visit = (s: S) => {
		if (done.has(s.name)) return;
		if (visiting.has(s.name))
			throw new Error(`dependency cycle through ${s.name}`);
		visiting.add(s.name);
		for (const d of s.dependsOn) {
			const dep = byName.get(d);
			if (dep) visit(dep);
		}
		visiting.delete(s.name);
		done.add(s.name);
		out.push(s);
	};
	for (const s of services) visit(s);
	return out;
}

export const Template = z
	.object({
		schema: z.literal(1),
		id: TemplateId,
		name: z.string().min(1).max(100),
		description: z.string().max(1000),
		category: TemplateCategory,
		tags: z.array(z.string().min(1).max(40)).max(20),
		/** Path relative to the catalog directory, e.g. `logos/n8n.svg`; absent means a monogram. */
		logo: z
			.string()
			.regex(/^logos\/[a-z0-9-]+\.(svg|png|jpg|webp)$/)
			.optional(),
		website: z.url().optional(),
		docs: z.url().optional(),
		/** The template's own version: the primary image's tag. */
		version: z.string().min(1),
		source: TemplateSource,
		inputs: z.array(TemplateInput),
		services: z.array(TemplateService).min(1),
	})
	.superRefine((t, ctx) => {
		const issue = (message: string) =>
			ctx.addIssue({ code: "custom", message });
		const inputs = new Map(t.inputs.map((i) => [i.key, i]));
		if (inputs.size !== t.inputs.length) issue("input keys must be unique");
		const names = new Set(t.services.map((s) => s.name));
		if (names.size !== t.services.length) issue("service names must be unique");
		for (const m of dependencyIssues(t.services)) issue(m);
		const domainUse = new Map<string, number>();
		for (const s of t.services) {
			for (const [key, value] of Object.entries(s.env))
				for (const r of templateRefs(value)) {
					if (r.kind === "input" && !inputs.has(r.key))
						issue(`${s.name}.env.${key}: unknown input ${r.key}`);
					if (r.kind === "service" && !names.has(r.name))
						issue(`${s.name}.env.${key}: unknown service ${r.name}`);
				}
			for (const f of s.files)
				for (const r of templateRefs(f.content))
					if (r.kind === "input" ? !inputs.has(r.key) : !names.has(r.name))
						issue(`${s.name} file ${f.target}: unknown reference`);
			// argv and healthchecks live in the plain spec, so secrets must never reach them.
			const argv =
				s.kind === "application"
					? [...(s.command ?? []), ...(s.entrypoint ?? [])]
					: [];
			for (const r of argv.flatMap(templateRefs))
				if (
					r.kind === "input" &&
					secretInputTypes.includes(inputs.get(r.key)?.type ?? "text")
				)
					issue(`${s.name}: secret input ${r.key} on the command line`);
				else if (r.kind === "input" ? !inputs.has(r.key) : !names.has(r.name))
					issue(`${s.name}: unknown reference in command`);
			if (s.kind === "application" && s.healthcheck?.type === "command")
				if (s.healthcheck.command.some((a) => templateRefs(a).length))
					issue(`${s.name}.healthcheck: expressions are not expanded there`);
			if (s.kind === "application" && s.public) {
				const input = inputs.get(s.public.domain);
				if (input?.type !== "domain")
					issue(
						`${s.name}.public.domain: ${s.public.domain} is not a domain input`,
					);
				domainUse.set(
					s.public.domain,
					(domainUse.get(s.public.domain) ?? 0) + 1,
				);
			}
		}
		for (const i of t.inputs)
			if (i.type === "domain" && domainUse.get(i.key) !== 1)
				issue(`domain input ${i.key} must route exactly one public service`);
		if (
			t.inputs.filter((i) => i.type === "domain" && i.role === "primary")
				.length > 1
		)
			issue("at most one primary domain");
	});
export type Template = z.infer<typeof Template>;

/** One row of `catalog/index.json`: what the gallery needs, nothing more. */
export const TemplateSummary = z.object({
	id: TemplateId,
	name: z.string(),
	description: z.string(),
	category: TemplateCategory,
	tags: z.array(z.string()),
	logo: z.string().optional(),
	source: TemplateSource.shape.kind,
	services: z.int().min(1),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

/** Deploy request: values keyed by input key; empty or absent generated inputs are generated. */
export const TemplateDeployInput = z.object({
	/** Instance name; a repeat with the same name in the same environment returns the first result. */
	name: TemplateServiceName.optional(),
	inputs: z.record(InputKey, z.string().max(4096)).default({}),
});
export type TemplateDeployInput = z.infer<typeof TemplateDeployInput>;
