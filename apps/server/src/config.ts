import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const optional = z.string().min(1).optional();

const ConfigSchema = z.object({
	DATABASE_URL: z.url(),
	REDIS_URL: z.url(),
	/** Swarm service of the Caddy proxy; agents follow its access log for traffic analytics. */
	LS_CADDY_SERVICE: z.string().default("logistack_caddy"),
	/** 32 random bytes, base64 (`openssl rand -base64 32`). */
	LOGISTACK_MASTER_KEY: z.string().refine((v) => {
		try {
			return Uint8Array.fromBase64(v.trim()).length === 32;
		} catch {
			return false;
		}
	}, "must be 32 bytes, base64"),
	/** The master key being replaced: values not re-encrypted yet still open with it. Remove once the worker logs that rotation finished. */
	LOGISTACK_MASTER_KEY_PREVIOUS: optional,
	BETTER_AUTH_SECRET: z.string().min(32),
	BETTER_AUTH_URL: z.url(),
	WEB_ORIGIN: z.url(),
	/** 0 picks a free port. */
	PORT: z.coerce.number().int().min(0).max(65535).default(3000),
	/** Server IP used for generated sslip/nip hostnames. */
	PUBLIC_IP: z.union([z.ipv4(), z.ipv6()]).optional(),
	LOG_LEVEL: z.enum(["info", "silent"]).default("info"),
	/** Largest object the storage browser accepts in one upload. */
	MAX_UPLOAD_BYTES: z.coerce
		.number()
		.int()
		.positive()
		.default(50 * 1024 ** 3),
	/** Sign-in, sign-up, second-factor and password-reset attempts per client address and minute. */
	RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().positive().default(30),
	/** Requests per API key and minute, across every api replica. */
	RATE_LIMIT_API_KEY_PER_MINUTE: z.coerce
		.number()
		.int()
		.positive()
		.default(600),
	/** Largest dump the database restore route takes; the body must declare its length. */
	MAX_RESTORE_BYTES: z.coerce
		.number()
		.int()
		.positive()
		.default(20 * 1024 ** 3),
	/** The built web app, served with an SPA fallback when its index.html exists. */
	WEB_DIST_DIR: z
		.string()
		.default(fileURLToPath(new URL("../../web/dist", import.meta.url))),
	/** Image of the one-shot jobs that probe a local backup destination; matches the worker's. */
	LS_BACKUP_TOOLS_IMAGE: z.string().default("alpine:3.22"),
	/** The installer's enrollment token: an agent presenting it gets a per-node token. Unset, no node can enroll. */
	LOGISTACK_AGENT_TOKEN: optional,
	/** install.sh --public-setup: first-run setup requires this token until it completes. Unset, setup is reachable only through the loopback tunnel. */
	LOGISTACK_SETUP_TOKEN: optional,
	/** The installer's loopback tunnel (`ssh -L`), trusted for sign-in; empty when it runs none. */
	LOGISTACK_TUNNEL_ORIGIN: z
		.union([z.url(), z.literal("")])
		.optional()
		.transform((v) => v || undefined),
	/** Set at image build time (Dockerfile ARG); `dev` from a checkout. */
	LOGISTACK_VERSION: z.string().min(1).default("dev"),
	// A build without git (the smoke test's dind) bakes an empty ENV; that means unknown, not invalid.
	LOGISTACK_COMMIT: z
		.string()
		.optional()
		.transform((v) => v || undefined),
	/** Dokploy's Postgres, set by install.sh on a Dokploy server (MIG-5); see `dokploySource`. */
	DOKPLOY_POSTGRES_PASSWORD: optional,
	DOKPLOY_POSTGRES_USER: z.string().min(1).default("dokploy"),
	DOKPLOY_POSTGRES_DB: z.string().min(1).default("dokploy"),
	/** Dokploy's ENCRYPTION_KEY or BETTER_AUTH_SECRET, as a file: it encrypts env at rest. */
	DOKPLOY_KEY_FILE: optional,
	/**
	 * Coolify's Postgres and APP_KEY, set by install.sh on a Coolify server (COOL-4) from
	 * `/data/coolify/source/.env`, as Swarm secrets (`COOLIFY_DB_PASSWORD_FILE`, `COOLIFY_APP_KEY_FILE`).
	 * The api reaches `coolify-db` over LogiStack's bridge overlay.
	 */
	COOLIFY_DB_PASSWORD: optional,
	COOLIFY_APP_KEY: optional,
	COOLIFY_DB_USER: z.string().min(1).default("coolify"),
	COOLIFY_DB_NAME: z.string().min(1).default("coolify"),
	COOLIFY_DB_HOST: z.string().min(1).default("coolify-db"),
	/** Trusts sponsor keys from Stripe's sandbox. Set only on test instances. */
	LOGISTACK_SPONSOR_SANDBOX: z
		.enum(["", "0", "1", "true", "false"])
		.optional()
		.transform((v) => v === "1" || v === "true"),
	/**
	 * Extra trusted signing keys of the official plugin index, base64url raw Ed25519, comma-separated.
	 * Added to `PLUGIN_INDEX_KEYS`, which is empty (a placeholder) until a release bundles the production key.
	 */
	LS_PLUGIN_INDEX_PUBLIC_KEY: optional,
	/** The official plugin index is its sandbox. Set only on test instances. */
	LOGISTACK_PLUGIN_INDEX_SANDBOX: z
		.enum(["", "0", "1", "true", "false"])
		.optional()
		.transform((v) => v === "1" || v === "true"),
	GITHUB_CLIENT_ID: optional,
	GITHUB_CLIENT_SECRET: optional,
	GOOGLE_CLIENT_ID: optional,
	GOOGLE_CLIENT_SECRET: optional,
});

export type Config = z.infer<typeof ConfigSchema>;

/** Every key also accepts `<KEY>_FILE` (Docker secrets); the file wins over the plain variable. */
export function loadConfig(
	env: Record<string, string | undefined> = process.env,
): Config {
	const raw: Record<string, string | undefined> = {};
	for (const key of Object.keys(ConfigSchema.shape)) {
		const file = env[`${key}_FILE`];
		raw[key] = file ? readFileSync(file, "utf8").trim() : env[key];
	}
	const parsed = ConfigSchema.safeParse(raw);
	if (!parsed.success)
		throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
	return parsed.data;
}
