import type { TemplateService } from "@logistack/contracts";
import { type ComposeBuild, isRecord, mapServices, Skip } from "./compose.ts";

/**
 * A compose file written by a user, as the services a stack creates. Nothing routes a domain
 * yet; `${VAR:-default}` takes its default and any other unset variable is empty. A service's
 * `build:` is refused unless `builds` is given: then it is recorded there by service name, and
 * that service's `image` is empty for the caller to replace with a build. Throws Skip listing
 * every part LogiStack cannot run.
 */
export function fromCompose(
	yaml: string,
	builds?: Map<string, ComposeBuild>,
): TemplateService[] {
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
		...(builds && { builds }),
	});
}
