/**
 * Docker names of the platform a migration comes from. They are fixed by that platform, but
 * settings here so tests can point them at their own `ls-test-*` objects.
 */
import type { MigrationSource } from "@logistack/contracts";
import { type RouterFlavor, sourceProfiles } from "@logistack/core";
import { DOKPLOY_ACME_PATH } from "./acme-import.ts";
import type { Config } from "./config.ts";

export type SourceSettings = {
	label: string;
	router: RouterFlavor;
	/** The network moved services join under their old names until the source is removed. */
	network: string;
	/** Its proxy: a container or a Swarm service by this exact name. */
	proxy: string;
	/** Where that proxy keeps Traefik's ACME state, read from inside its container. */
	acmePath: string;
};

export function sourceSettings(
	cfg: Config,
	source: MigrationSource,
): SourceSettings {
	const { label, router } = sourceProfiles[source];
	return source === "dokploy"
		? {
				label,
				router,
				network: cfg.LS_DOKPLOY_NETWORK,
				proxy: cfg.LS_DOKPLOY_TRAEFIK,
				acmePath: DOKPLOY_ACME_PATH,
			}
		: {
				label,
				router,
				network: cfg.LS_COOLIFY_NETWORK,
				proxy: cfg.LS_COOLIFY_PROXY,
				acmePath: "/traefik/acme.json",
			};
}
