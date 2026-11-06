import { gamePorts, type ServiceSpec } from "@logistack/contracts";
import { databaseImage } from "@logistack/core";

export type ComposeViewService = {
	slug: string;
	spec: ServiceSpec;
	/** `null` for a secret: the view names it but never shows it. */
	env: { key: string; value: string | null }[];
	volumes: { name: string; target: string; readOnly: boolean }[];
	domains: string[];
};

export const MASKED = "<secret>";

/**
 * A stack's desired state written as a compose file, for reading. Pure; nothing deploys it.
 * Swarm-only details (labels, networks, configs) are left out; domains become `x-domains`.
 */
export function stackCompose(services: ComposeViewService[]): string {
	const volumes = new Set<string>();
	const out: Record<string, unknown> = {};
	for (const s of services) {
		const spec = s.spec;
		const svc: Record<string, unknown> = {};
		if (spec.kind === "application") {
			if (spec.source.type === "image") svc.image = spec.source.image;
			else
				svc.build = `${spec.source.repository}#${spec.source.branch}:${spec.source.path}`;
			if (spec.entrypoint) svc.entrypoint = spec.entrypoint;
			if (spec.command) svc.command = spec.command;
			if (spec.ports.length)
				svc.ports = spec.ports.map((p) =>
					p.published
						? `${p.published}:${p.target}/${p.protocol}`
						: `${p.target}/${p.protocol}`,
				);
			if (spec.user) svc.user = spec.user;
			if (spec.replicas !== 1) svc.deploy = { replicas: spec.replicas };
		} else if (spec.kind === "database")
			svc.image = databaseImage(spec.engine, spec.version);
		else if (spec.kind === "storage") svc["x-storage"] = spec.engine;
		else if (spec.kind === "game") {
			svc["x-game"] = spec.settings.game;
			svc.ports = gamePorts(spec.settings, spec.port).map(
				(p) => `${p.published}:${p.target}/${p.protocol}`,
			);
		}
		if (s.env.length)
			svc.environment = Object.fromEntries(
				s.env.map((e) => [e.key, e.value ?? MASKED]),
			);
		if (s.volumes.length) {
			svc.volumes = s.volumes.map(
				(v) => `${v.name}:${v.target}${v.readOnly ? ":ro" : ""}`,
			);
			for (const v of s.volumes) volumes.add(v.name);
		}
		if (s.domains.length) svc["x-domains"] = s.domains;
		out[s.slug] = svc;
	}
	const doc: Record<string, unknown> = { services: out };
	if (volumes.size)
		doc.volumes = Object.fromEntries([...volumes].map((v) => [v, {}]));
	return Bun.YAML.stringify(doc, null, 2).replace(/ +$/gm, "");
}
