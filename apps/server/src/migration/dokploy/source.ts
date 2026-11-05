import type { Config } from "../../config.ts";

/** Dokploy's own paths and service names: fixed by Dokploy, not configurable there either. */
export const DOKPLOY_ROOT = "/etc/dokploy";
const DOKPLOY_POSTGRES_HOST = "dokploy-postgres";

/**
 * The arguments for `readDokploy` on a server where install.sh found Dokploy: it mounts
 * `/etc/dokploy` read-only, joins `dokploy-network` and hands over the password as a secret.
 * Undefined anywhere else.
 */
export function dokploySource(
	cfg: Pick<
		Config,
		| "DOKPLOY_POSTGRES_PASSWORD"
		| "DOKPLOY_POSTGRES_USER"
		| "DOKPLOY_POSTGRES_DB"
	>,
): { url: string; composeRoot: string } | undefined {
	if (!cfg.DOKPLOY_POSTGRES_PASSWORD) return undefined;
	const e = encodeURIComponent;
	return {
		url: `postgres://${e(cfg.DOKPLOY_POSTGRES_USER)}:${e(cfg.DOKPLOY_POSTGRES_PASSWORD)}@${DOKPLOY_POSTGRES_HOST}:5432/${e(cfg.DOKPLOY_POSTGRES_DB)}`,
		composeRoot: `${DOKPLOY_ROOT}/compose`,
	};
}
