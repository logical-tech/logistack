import type { Config } from "../../config.ts";

/**
 * The arguments for `readCoolify` on a server where install.sh found Coolify: it hands over the
 * database password and APP_KEY as secrets and connects `coolify-db` to the bridge overlay the api
 * joins. Undefined anywhere else.
 */
export function coolifySource(
	cfg: Pick<
		Config,
		| "COOLIFY_DB_PASSWORD"
		| "COOLIFY_APP_KEY"
		| "COOLIFY_DB_USER"
		| "COOLIFY_DB_NAME"
		| "COOLIFY_DB_HOST"
	>,
): { url: string; appKey: string } | undefined {
	if (!cfg.COOLIFY_DB_PASSWORD || !cfg.COOLIFY_APP_KEY) return undefined;
	const e = encodeURIComponent;
	return {
		url: `postgres://${e(cfg.COOLIFY_DB_USER)}:${e(cfg.COOLIFY_DB_PASSWORD)}@${cfg.COOLIFY_DB_HOST}:5432/${e(cfg.COOLIFY_DB_NAME)}`,
		appKey: cfg.COOLIFY_APP_KEY.trim(),
	};
}
