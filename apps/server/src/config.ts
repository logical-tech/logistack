import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const optional = z.string().min(1).optional();

const ConfigSchema = z.object({
	DATABASE_URL: z.url(),
	REDIS_URL: z.url(),
	/** 32 random bytes, base64 (`openssl rand -base64 32`). */
	LOGISTACK_MASTER_KEY: z.string().refine((v) => {
		try {
			return Uint8Array.fromBase64(v.trim()).length === 32;
		} catch {
			return false;
		}
	}, "must be 32 bytes, base64"),
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
	/** The built web app, served with an SPA fallback when its index.html exists. */
	WEB_DIST_DIR: z
		.string()
		.default(fileURLToPath(new URL("../../web/dist", import.meta.url))),
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
