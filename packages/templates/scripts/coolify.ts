/**
 * Coolify `templates/compose/<id>.yaml`: plain compose with `# key: value` headers and magic
 * env names (`SERVICE_PASSWORD_DB`, `SERVICE_URL_APP_3000`) that Coolify fills at deploy.
 * Each magic name becomes a typed input.
 */
import type { TemplateInput } from "@logistack/contracts";
import {
	type Domain,
	entries,
	expr,
	Inputs,
	interpolate,
	isRecord,
	mapServices,
	type Raw,
	type Resolve,
	Skip,
	slug,
} from "../src/compose.ts";
import type { Draft } from "./draft.ts";

/** `# documentation: https://...` lines before the YAML body. */
export function headers(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const m = /^#\s*([a-z_]+):\s*(.*)$/.exec(line);
		if (m) out[m[1] as string] = (m[2] as string).trim();
		else if (line.trim() && !line.startsWith("#")) break;
	}
	return out;
}

const MAGIC =
	/^SERVICE_(PASSWORD|USER|BASE64|REALBASE64|HEX)(?:_(\d+))?_([A-Z0-9_]+)$/;
const URL_VAR = /^SERVICE_(URL|FQDN)_([A-Z0-9_]+?)(?:_(\d+))?$/;
// Magic Coolify mints as JWTs; LogiStack has no generator for them.
const UNSUPPORTED = /^SERVICE_(SUPABASEANON|SUPABASESERVICE)_/;

const words = (id: string) => id.toLowerCase().replaceAll("_", " ");

export function fromCoolify(id: string, text: string): Draft {
	const h = headers(text);
	if (h.ignore === "true")
		throw new Skip([{ code: "ignored", detail: "marked ignore upstream" }]);
	const compose = Bun.YAML.parse(text);
	if (!isRecord(compose) || !isRecord(compose.services))
		throw new Skip([{ code: "invalid", detail: "no services" }]);
	const services = compose.services as Record<string, Raw>;
	const headerPort = Number(h.port) || undefined;

	// Declarations: an env key `SERVICE_URL_<ID>_<PORT>` (or FQDN) makes its service public.
	const declared = new Map<
		string,
		{ service: string; port: number | undefined }
	>();
	for (const [name, svc] of Object.entries(services)) {
		if (!isRecord(svc)) continue;
		const kept: [string, string | undefined][] = [];
		for (const [key, value] of entries(svc.environment)) {
			const m = URL_VAR.exec(key);
			if (m && (value === undefined || value === "")) {
				const prev = declared.get(m[2] as string);
				if (prev && prev.service !== name)
					throw new Skip([
						{ code: "domain", detail: `${m[2]} is declared on two services` },
					]);
				declared.set(m[2] as string, {
					service: name,
					port: Number(m[3]) || prev?.port,
				});
				continue;
			}
			if (m && value?.startsWith("/"))
				throw new Skip([
					{ code: "domain_path", detail: `${key} routes a path prefix` },
				]);
			kept.push([key, value]);
		}
		svc.environment = Object.fromEntries(kept.map(([k, v]) => [k, v ?? null]));
	}
	// A URL referenced but never declared belongs to the service of that name, on the header port.
	for (const m of text.matchAll(/SERVICE_(?:URL|FQDN)_([A-Z0-9_]+)/g)) {
		const ref = URL_VAR.exec(`SERVICE_URL_${m[1]}`);
		const id2 = ref?.[2] as string;
		if (declared.has(id2)) continue;
		const owner = Object.keys(services).find((s) => slug(s) === slug(id2));
		if (!owner)
			throw new Skip([
				{ code: "domain", detail: `SERVICE_URL_${id2} names no service` },
			]);
		declared.set(id2, { service: owner, port: Number(ref?.[3]) || undefined });
	}

	const inputs = new Inputs();
	const domains = new Map<string, Domain>();
	const domainKey = new Map<string, string>();
	for (const [urlId, d] of declared) {
		if (domains.has(d.service))
			throw new Skip([
				{
					code: "two_domains",
					detail: `${d.service} has more than one public URL`,
				},
			]);
		const key = inputs.use(
			`domain:${urlId}`,
			`${words(urlId)} domain`,
			(key) => ({
				key,
				type: "domain",
				role: domains.size === 0 ? "primary" : "extra",
				label: `${urlId.replaceAll("_", " ")} domain`,
			}),
		);
		domainKey.set(urlId, key);
		domains.set(d.service, { input: key, port: d.port ?? headerPort ?? 80 });
	}

	const secretInputs = new Set<string>();
	const generated = (
		identity: string,
		preferred: string,
		make: (key: string) => TemplateInput,
	) => {
		const key = inputs.use(identity, preferred, make);
		if (
			["password", "secret", "base64"].includes(
				inputs.list.find((i) => i.key === key)?.type ?? "",
			)
		)
			secretInputs.add(key);
		return expr(key);
	};
	const resolve: Resolve = (name, op, arg) => {
		if (UNSUPPORTED.test(name))
			throw new Skip([{ code: "jwt", detail: `${name} is a generated JWT` }]);
		const url = URL_VAR.exec(name);
		if (url) {
			const key = domainKey.get(url[2] as string);
			if (!key)
				throw new Skip([{ code: "domain", detail: `${name} is not declared` }]);
			return url[1] === "URL" ? `https://${expr(key)}` : expr(key);
		}
		const m = MAGIC.exec(name);
		if (m) {
			const [, kind, n, rawId] = m as unknown as [
				string,
				string,
				string | undefined,
				string,
			];
			const label = rawId.replaceAll("_", " ");
			switch (kind) {
				case "PASSWORD":
					return generated(name, `${words(rawId)} password`, (key) => ({
						key,
						type: "password",
						length: Number(n) || 32,
						label: `${label} password`,
					}));
				case "USER":
					return generated(name, `${words(rawId)} user`, (key) => ({
						key,
						type: "username",
						label: `${label} user`,
					}));
				case "BASE64":
					return generated(name, `${words(rawId)} secret`, (key) => ({
						key,
						type: "secret",
						length: Number(n) || 32,
						charset: "alnum",
						label: `${label} secret`,
					}));
				case "REALBASE64":
					return generated(name, `${words(rawId)} key`, (key) => ({
						key,
						type: "base64",
						bytes: Number(n) || 32,
						label: `${label} key`,
					}));
				default:
					return generated(name, `${words(rawId)} hex`, (key) => ({
						key,
						type: "secret",
						length: Number(n) || 32,
						charset: "hex",
						label: `${label} key`,
					}));
			}
		}
		if (op?.endsWith("-")) return interpolate(arg ?? "", resolve);
		if (op?.endsWith("+"))
			throw new Skip([
				{ code: "interpolation", detail: `\${${name}${op}...}` },
			]);
		const required = op?.endsWith("?") ?? false;
		return expr(
			inputs.use(`text:${name}`, name, (key) => ({
				key,
				type: "text",
				label: name,
				...(!required && { default: "" }),
			})),
		);
	};

	const mapped = mapServices(compose, { resolve, domains, secretInputs });
	return {
		id: slug(id),
		name: id
			.split(/[-_]/)
			.map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
			.join(" "),
		description: h.slogan ?? "",
		categoryHint: [h.category ?? "", ...(h.tags?.split(",") ?? [])],
		tags: (h.tags ?? "")
			.split(",")
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean),
		...(h.documentation && { docs: h.documentation }),
		...(h.logo && { logoFile: h.logo }),
		source: {
			kind: "coolify",
			path: `templates/compose/${id}.yaml`,
			license: "Apache-2.0",
		},
		inputs: inputs.list,
		services: mapped,
	};
}
