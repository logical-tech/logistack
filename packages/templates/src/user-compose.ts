import type { TemplateService } from "@logistack/contracts";
import { isRecord, mapServices, Skip } from "./compose.ts";

/**
 * A compose file pasted by a user, as the services a stack creates. Nothing routes a domain
 * yet; `${VAR:-default}` takes its default and any other unset variable is empty. Throws Skip
 * listing every part LogiStack cannot run.
 */
export function fromCompose(yaml: string): TemplateService[] {
	let compose: unknown;
	try {
		compose = Bun.YAML.parse(yaml);
	} catch (e) {
		throw new Skip([{ code: "yaml", detail: (e as Error).message }]);
	}
	if (!isRecord(compose))
		throw new Skip([{ code: "invalid", detail: "compose is not a mapping" }]);
	return mapServices(compose, {
		resolve: (_name, op, arg) => (op?.endsWith("-") ? (arg ?? "") : ""),
		domains: new Map(),
		secretInputs: new Set(),
	});
}
