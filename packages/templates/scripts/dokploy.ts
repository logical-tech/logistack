/**
 * Dokploy `blueprints/<id>/`: `docker-compose.yml`, `template.toml` (variables with helpers
 * such as `${password:32}`, env written to `.env`, routed domains, shipped files) and
 * `meta.json`. Helpers become typed inputs; `.env` entries become what `${KEY}` resolves to.
 */
import type { TemplateInput } from "@logistack/contracts";
import {
	type Domain,
	entries,
	expr,
	Inputs,
	isRecord,
	mapServices,
	type Resolve,
	Skip,
	slug,
} from "../src/compose.ts";
import type { Draft } from "./draft.ts";

export type DokployBlueprint = {
	folder: string;
	meta: Record<string, unknown>;
	toml: string;
	compose: string;
};

const HELPER =
	/\$\{(domain|password|base64|hash|uuid|randomPort|email|username|timestamp|timestamps|timestampms|jwt)(?::([^}]*))?\}/g;
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const normalizePath = (p: string) =>
	p.replace(/^(\.\.\/files\/|\.\/)/, "").replace(/^\/+/, "");

export function fromDokploy(b: DokployBlueprint): Draft {
	const toml = Bun.TOML.parse(b.toml) as Record<string, unknown>;
	const variables = (isRecord(toml.variables) ? toml.variables : {}) as Record<
		string,
		unknown
	>;
	const config = isRecord(toml.config) ? toml.config : {};
	const inputs = new Inputs();
	const secretInputs = new Set<string>();

	const helper = (
		identity: string,
		name: string,
		kind: string,
		arg: string | undefined,
	): string => {
		const n = Number(arg) || undefined;
		const make = (key: string): TemplateInput => {
			const label = name;
			switch (kind) {
				case "domain":
					return { key, type: "domain", role: "extra", label };
				case "password":
					return { key, type: "password", length: Math.max(n ?? 32, 8), label };
				case "base64":
					return { key, type: "base64", bytes: Math.max(n ?? 32, 8), label };
				case "hash":
					return {
						key,
						type: "secret",
						length: Math.max(n ?? 32, 8),
						charset: "hex",
						label,
					};
				case "uuid":
					return { key, type: "uuid", label };
				case "username":
					return { key, type: "username", label };
				case "email":
					return { key, type: "text", default: "admin@example.com", label };
				default:
					throw new Skip([
						{
							code: kind === "jwt" ? "jwt" : "helper",
							detail: `\${${kind}} in ${name}`,
						},
					]);
			}
		};
		const key = inputs.use(identity, name, make);
		if (["password", "base64", "hash"].includes(kind)) secretInputs.add(key);
		return expr(key);
	};

	const varCache = new Map<string, string>();
	const evaluate = (
		identity: string,
		name: string,
		value: string,
		seen: string[],
	): string => {
		let n = 0;
		return value
			.replace(HELPER, (_m, kind: string, arg?: string) =>
				helper(n++ ? `${identity}#${n}` : identity, name, kind, arg),
			)
			.replace(REF, (m, ref: string) => {
				if (!(ref in variables)) return m;
				if (seen.includes(ref))
					throw new Skip([
						{ code: "variables", detail: `cycle through ${ref}` },
					]);
				return variable(ref, [...seen, ref]);
			});
	};
	const variable = (name: string, seen: string[] = [name]): string => {
		const cached = varCache.get(name);
		if (cached !== undefined) return cached;
		const out = evaluate(
			`var:${name}`,
			name,
			String(variables[name] ?? ""),
			seen,
		);
		varCache.set(name, out);
		return out;
	};

	const rawEnv: [string, string | undefined][] = Array.isArray(config.env)
		? entries(config.env)
		: entries(isRecord(config.env) ? config.env : {});
	const env = new Map(
		rawEnv.map(([k, v]) => [k, evaluate(`env:${k}`, k, v ?? "", [])]),
	);

	const files = new Map<string, string>();
	for (const m of Array.isArray(config.mounts) ? config.mounts : []) {
		if (!isRecord(m) || typeof m.filePath !== "string") continue;
		files.set(
			normalizePath(m.filePath),
			evaluate(`file:${m.filePath}`, m.filePath, String(m.content ?? ""), []),
		);
	}

	const domains = new Map<string, Domain>();
	for (const [i, d] of (Array.isArray(config.domains)
		? config.domains
		: []
	).entries()) {
		if (!isRecord(d)) continue;
		const service = String(d.serviceName);
		const host = evaluate(
			`domain:${i}`,
			`${service} domain`,
			String(d.host ?? ""),
			[],
		);
		const key = /^\$\{\{ inputs\.([A-Za-z0-9]+) \}\}$/.exec(host)?.[1];
		const input = inputs.list.find((x) => x.key === key);
		if (input?.type !== "domain")
			throw new Skip([
				{
					code: "domain",
					detail: `${service} is routed at "${d.host}", not a domain variable`,
				},
			]);
		if (d.path && d.path !== "/")
			throw new Skip([
				{ code: "domain_path", detail: `${service} routes ${d.path}` },
			]);
		if (domains.has(service))
			throw new Skip([
				{ code: "two_domains", detail: `${service} has more than one domain` },
			]);
		if ([...domains.values()].some((x) => x.input === key))
			throw new Skip([
				{ code: "domain", detail: `${key} routes two services` },
			]);
		if (domains.size === 0) Object.assign(input, { role: "primary" });
		domains.set(service, { input: key as string, port: Number(d.port) });
	}
	for (const i of inputs.list)
		if (
			i.type === "domain" &&
			![...domains.values()].some((d) => d.input === i.key)
		)
			throw new Skip([
				{
					code: "domain_unrouted",
					detail: `${i.label} is a domain no service is routed at`,
				},
			]);

	const resolve: Resolve = (name, op, arg) => {
		const v = env.get(name) ?? (name in variables ? variable(name) : undefined);
		if (v !== undefined && !(op?.startsWith(":") && v === "")) return v;
		return op?.endsWith("-") ? (arg ?? "") : "";
	};

	const compose = Bun.YAML.parse(b.compose);
	if (!isRecord(compose))
		throw new Skip([{ code: "invalid", detail: "compose is not a mapping" }]);
	const services = mapServices(compose, {
		resolve,
		domains,
		secretInputs,
		file: (source) => files.get(normalizePath(source)),
		envFile: [...env],
	});
	for (const s of services)
		for (const f of s.files)
			if ([...secretInputs].some((k) => f.content.includes(expr(k))))
				f.secret = true;

	const links = isRecord(b.meta.links) ? b.meta.links : {};
	const tags = Array.isArray(b.meta.tags)
		? b.meta.tags.map((t) => String(t).toLowerCase())
		: [];
	return {
		id: slug(str(b.meta.id) ?? b.folder),
		name: str(b.meta.name) ?? b.folder,
		description: str(b.meta.description) ?? "",
		categoryHint: tags,
		tags,
		...(str(links.website) && { website: str(links.website) }),
		...(str(links.docs) && { docs: str(links.docs) }),
		...(str(b.meta.logo) && {
			logoFile: `blueprints/${b.folder}/${b.meta.logo}`,
		}),
		...(str(b.meta.version) && { version: str(b.meta.version) }),
		source: { kind: "dokploy", path: `blueprints/${b.folder}`, license: "MIT" },
		inputs: inputs.list,
		services,
	};
}
