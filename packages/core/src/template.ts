import {
	type ApplicationSpec,
	type DatabaseSpec,
	dependencyOrder,
	secretInputTypes,
	TEMPLATE_EXPRESSION,
	type Template,
	type TemplateInput,
	templateRefs,
} from "@logistack/contracts";
import { databaseDataDir } from "./compile-service.ts";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const HEX = "0123456789abcdef";

/** Unbiased: rejection-samples bytes that fall outside a multiple of the alphabet size. */
function randomString(alphabet: string, length: number): string {
	const limit = 256 - (256 % alphabet.length);
	let out = "";
	while (out.length < length)
		for (const b of crypto.getRandomValues(new Uint8Array(length * 2)))
			if (b < limit && out.length < length)
				out += alphabet[b % alphabet.length];
	return out;
}

/** A fresh value for a generated input; undefined for inputs the caller or a default fills. */
export function generateInput(input: TemplateInput): string | undefined {
	switch (input.type) {
		case "password":
			return randomString(ALNUM, input.length);
		case "secret":
			return randomString(input.charset === "hex" ? HEX : ALNUM, input.length);
		case "username":
			// A letter-only name is a valid role or user in every database engine.
			return input.default ?? randomString(LOWER, 12);
		case "base64":
			return crypto.getRandomValues(new Uint8Array(input.bytes)).toBase64();
		case "uuid":
			return crypto.randomUUID();
		case "text":
			return input.default;
		case "domain":
			return undefined;
	}
}

export type TemplateEnvEntry = {
	key: string;
	value: string;
	isSecret: boolean;
};

export type TemplateMount =
	| { kind: "volume"; target: string; volumeName: string; readOnly: boolean }
	| {
			kind: "config" | "secret";
			target: string;
			content: string;
			readOnly: true;
	  };

export type TemplateServicePlan = {
	name: string;
	spec: ApplicationSpec | DatabaseSpec;
	env: TemplateEnvEntry[];
	mounts: TemplateMount[];
	/** Hostname and container port the proxy routes to this service. */
	domain?: { hostname: string; port: number };
	dependsOn: string[];
};

/**
 * Pure: turns a template plus a complete value per input (generated ones already filled,
 * domains already resolved to hostnames) into services in dependency order.
 */
export function planTemplate(
	template: Template,
	values: Record<string, string>,
): TemplateServicePlan[] {
	const secret = new Set(
		template.inputs
			.filter((i) => secretInputTypes.includes(i.type))
			.map((i) => i.key),
	);
	const missing = template.inputs.filter((i) => values[i.key] === undefined);
	if (missing.length)
		throw new Error(`missing inputs: ${missing.map((i) => i.key).join(", ")}`);
	const expand = (v: string) =>
		v.replace(TEMPLATE_EXPRESSION, (_m, key?: string, name?: string) =>
			// A service's host is its slug, which is its template name.
			key ? (values[key] as string) : (name as string),
		);

	return dependencyOrder(template.services).map((s): TemplateServicePlan => {
		const env = Object.entries(s.env).map(([key, value]) => ({
			key,
			value: expand(value),
			isSecret: templateRefs(value).some(
				(r) => r.kind === "input" && secret.has(r.key),
			),
		}));
		// compileService mounts the database's own volume here; a template volume on it is dropped.
		const dataDir = s.kind === "database" ? databaseDataDir(s) : undefined;
		const mounts: TemplateMount[] = [
			...s.volumes
				.filter((v) => v.target !== dataDir)
				.map((v) => ({
					kind: "volume" as const,
					target: v.target,
					volumeName: v.name,
					readOnly: v.readOnly ?? false,
				})),
			...s.files.map((f) => ({
				kind: f.secret ? ("secret" as const) : ("config" as const),
				target: f.target,
				content: expand(f.content),
				readOnly: true as const,
			})),
		];
		const base = { name: s.name, env, mounts, dependsOn: s.dependsOn };
		if (s.kind === "database")
			return {
				...base,
				spec: {
					kind: "database",
					engine: s.engine,
					version: s.version,
					// Credentials are the service's own env vars, written with it.
					credentialsRef: "env",
					resources: {},
				},
			};
		const hostname = s.public ? values[s.public.domain] : undefined;
		return {
			...base,
			spec: {
				kind: "application",
				source: { type: "image", image: s.image },
				build: { type: "image" },
				ports: s.ports,
				replicas: 1,
				resources: s.resources ?? {},
				placement: [],
				...(s.command && { command: s.command.map(expand) }),
				...(s.entrypoint && { entrypoint: s.entrypoint.map(expand) }),
				...(s.healthcheck && { healthcheck: s.healthcheck }),
				...(s.user && { user: s.user }),
				...(s.capAdd?.length && { capAdd: s.capAdd }),
				...(s.capDrop?.length && { capDrop: s.capDrop }),
				...(s.restart && { restart: s.restart }),
			},
			...(s.public && hostname
				? { domain: { hostname, port: s.public.port } }
				: {}),
		};
	});
}
