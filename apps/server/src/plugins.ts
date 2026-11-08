import { z } from "@hono/zod-openapi";
import {
	PLUGIN_MANIFEST_LABEL,
	PluginManifest,
	PluginUserClaims,
} from "@logistack/contracts";
import { decrypt, pluginBaseUrl } from "@logistack/core";
import { type Db, pluginInstall, registry } from "@logistack/db";
import {
	callPlugin,
	type Fetch,
	type PluginTarget,
} from "@logistack/providers";
import { and, eq } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import type { Deps } from "./env.ts";
import { Failure, notFound } from "./errors.ts";
import { Registry, splitRegistryUrl } from "./registry/client.ts";
import { guardedFetch, hostPolicy } from "./ssrf.ts";

// Server side of plugins (docs/plans/plugins.md): reading a manifest from an image or a dev URL,
// calling an install, and the short-lived session tokens plugin pages carry.

export type InstallRow = typeof pluginInstall.$inferSelect;

/** `ghcr.io/acme/x:1.0`, `acme/x`, `localhost:5000/x@sha256:…` → registry host, repository, reference. */
export function parseImageRef(ref: string): {
	host: string;
	repo: string;
	reference: string;
} {
	const trimmed = ref.trim();
	if (!/^[a-z0-9][a-z0-9._\-/:@]*$/i.test(trimmed))
		throw new Failure("bad_request", "not an image reference");
	const at = trimmed.indexOf("@");
	let name = at >= 0 ? trimmed.slice(0, at) : trimmed;
	let reference = at >= 0 ? trimmed.slice(at + 1) : "latest";
	if (at < 0) {
		const colon = name.lastIndexOf(":");
		if (colon > name.lastIndexOf("/")) {
			reference = name.slice(colon + 1);
			name = name.slice(0, colon);
		}
	}
	const parts = name.split("/");
	const first = parts[0] ?? "";
	const hasHost =
		parts.length > 1 &&
		(first.includes(".") || first.includes(":") || first === "localhost");
	const host = hasHost ? first : "docker.io";
	let repo = hasHost ? parts.slice(1).join("/") : name;
	if (host === "docker.io" && !repo.includes("/")) repo = `library/${repo}`;
	if (!repo) throw new Failure("bad_request", "not an image reference");
	return { host, repo, reference };
}

const ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type IndexDoc = {
	manifests?: {
		digest: string;
		platform?: { os?: string; architecture?: string };
	}[];
	config?: { digest: string };
};

const arch = process.arch === "arm64" ? "arm64" : "amd64";

/**
 * Reads the manifest label without pulling the image: the registry manifest (an index picks
 * this server's platform), then the config blob's labels. Returns the digest-pinned ref (rule 6).
 */
export async function manifestFromImage(
	db: Db,
	masterKey: CryptoKey,
	organizationId: string,
	image: string,
	registryId?: string,
	fetchFn: typeof fetch = fetch,
): Promise<{ manifest: PluginManifest; image: string }> {
	const { host, repo, reference } = parseImageRef(image);
	let creds: { username: string; password: string } | undefined;
	if (registryId) {
		const [reg] = await db
			.select()
			.from(registry)
			.where(
				and(
					eq(registry.id, registryId),
					eq(registry.organizationId, organizationId),
				),
			);
		if (!reg) throw notFound("registry");
		if (reg.username && reg.passwordEncrypted)
			creds = {
				username: reg.username,
				password: await decrypt(masterKey, reg.passwordEncrypted),
			};
	}
	const apiHost = host === "docker.io" ? splitRegistryUrl(host).host : host;
	const client = new Registry(apiHost, creds, fetchFn);
	const scope = `repository:${repo}:pull`;
	const get = async (path: string, accept = ACCEPT) => {
		const res = await client.request(path, { scope, headers: { accept } });
		if (!res.ok)
			throw new Failure(
				"bad_request",
				res.status === 404
					? `${image} was not found in its registry`
					: res.status === 401 || res.status === 403
						? `the registry refused ${image}: pick registry credentials`
						: `the registry answered ${res.status} for ${image}`,
			);
		return res;
	};
	const top = await get(`/${repo}/manifests/${reference}`);
	const topText = await top.text();
	const digest =
		top.headers.get("docker-content-digest") ??
		`sha256:${new Bun.CryptoHasher("sha256").update(topText).digest("hex")}`;
	let doc = JSON.parse(topText) as IndexDoc;
	if (doc.manifests) {
		const pick =
			doc.manifests.find(
				(m) => m.platform?.os === "linux" && m.platform.architecture === arch,
			) ?? doc.manifests.find((m) => m.platform?.os === "linux");
		if (!pick) throw new Failure("bad_request", `${image} has no linux image`);
		doc = (await (
			await get(`/${repo}/manifests/${pick.digest}`)
		).json()) as IndexDoc;
	}
	if (!doc.config?.digest)
		throw new Failure("bad_request", `${image} has no image config`);
	const config = (await (
		await get(`/${repo}/blobs/${doc.config.digest}`, "*/*")
	).json()) as { config?: { Labels?: Record<string, string> | null } };
	const raw = config.config?.Labels?.[PLUGIN_MANIFEST_LABEL];
	if (!raw)
		throw new Failure(
			"bad_request",
			`${image} is not a LogiStack plugin: it has no ${PLUGIN_MANIFEST_LABEL} label`,
		);
	const pinnedHost = host === "docker.io" ? "docker.io" : host;
	return {
		manifest: parseManifest(raw),
		image: `${pinnedHost}/${repo}@${digest}`,
	};
}

export function parseManifest(raw: unknown): PluginManifest {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			throw new Failure("bad_request", "the plugin manifest is not JSON");
		}
	}
	const parsed = PluginManifest.safeParse(value);
	if (!parsed.success)
		throw new Failure(
			"validation_failed",
			"the plugin manifest is invalid",
			parsed.error.issues,
		);
	return parsed.data;
}

/**
 * The fetch a dev URL is called with: the SSRF guard, like webhooks. Plain http is allowed to a
 * private address once the instance allows private hosts (a plugin on the developer's machine).
 */
export async function devFetch(db: Db): Promise<Fetch> {
	const policy = await hostPolicy(db);
	return (url, init) => guardedFetch(url, init ?? {}, policy, undefined, true);
}

/** A dev-URL plugin serves its manifest at `GET /v1/manifest`. */
export async function manifestFromUrl(
	db: Db,
	url: string,
): Promise<PluginManifest> {
	let base: URL;
	try {
		base = new URL(url);
	} catch {
		throw new Failure("bad_request", "not a URL");
	}
	if (base.protocol !== "https:" && base.protocol !== "http:")
		throw new Failure("bad_request", "the dev URL must be http or https");
	const f = await devFetch(db);
	const res = await f(`${base.href.replace(/\/+$/, "")}/v1/manifest`, {
		signal: AbortSignal.timeout(10_000),
		redirect: "manual",
	}).catch((e: unknown) => {
		throw new Failure(
			"bad_request",
			`could not reach the plugin: ${e instanceof Error ? e.message : String(e)}`,
		);
	});
	if (!res.ok)
		throw new Failure(
			"bad_request",
			`the plugin answered ${res.status} on /v1/manifest`,
		);
	return parseManifest(await res.text());
}

/** How the api reaches an install, and with what key it signs. */
export async function pluginTarget(
	deps: Pick<Deps, "masterKey">,
	row: InstallRow,
	prefix = "",
): Promise<PluginTarget> {
	return {
		baseUrl: pluginBaseUrl(row, prefix),
		installId: row.id,
		signingSecret: await decrypt(deps.masterKey, row.signingSecretEncrypted),
	};
}

/** Calls an install: containers directly on the plugins network, dev URLs through the SSRF guard. */
export async function callInstall<T>(
	deps: Pick<Deps, "masterKey" | "db">,
	row: InstallRow,
	path: string,
	payload: unknown,
	opts: { method?: "GET" | "POST"; timeoutMs?: number } = {},
): Promise<T> {
	const target = await pluginTarget(deps, row);
	return callPlugin<T>(target, path, payload, {
		...opts,
		...(row.devUrl ? { fetch: await devFetch(deps.db) } : {}),
	});
}

export async function installRow(
	db: Db,
	organizationId: string,
	id: string,
): Promise<InstallRow> {
	const [row] = await db
		.select()
		.from(pluginInstall)
		.where(
			and(
				eq(pluginInstall.id, id),
				eq(pluginInstall.organizationId, organizationId),
			),
		);
	if (!row) throw notFound("plugin");
	return row;
}

/** Plugin page session tokens: 5 minutes, signed with a key only the api derives. */
export const SESSION_TTL_S = 300;

const sessionKey = (authSecret: string) =>
	new Bun.CryptoHasher("sha256")
		.update(`logistack-plugin-session:${authSecret}`)
		.digest("hex");

export async function signSession(
	authSecret: string,
	claims: PluginUserClaims,
	nowS = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresAt: string }> {
	const exp = nowS + SESSION_TTL_S;
	const token = await sign(
		{ ...claims, aud: "logistack-plugin-page", iat: nowS, exp },
		sessionKey(authSecret),
		"HS256",
	);
	return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The claims of a valid, unexpired token for `installId`; undefined otherwise. */
export async function verifySession(
	authSecret: string,
	token: string,
	installId: string,
): Promise<PluginUserClaims | undefined> {
	try {
		const payload = await verify(token, sessionKey(authSecret), {
			alg: "HS256",
			aud: "logistack-plugin-page",
		});
		const claims = PluginUserClaims.safeParse(payload);
		if (!claims.success || claims.data.installId !== installId)
			return undefined;
		return claims.data;
	} catch {
		return undefined;
	}
}

/** Validates settings against the manifest's JSON Schema. */
export function validateConfig(
	schema: PluginManifest["config"],
	config: Record<string, unknown>,
): Record<string, unknown> {
	let validator: z.ZodType;
	try {
		validator = z.fromJSONSchema(schema as never);
	} catch {
		throw new Failure(
			"bad_request",
			"the plugin's settings schema is not usable",
		);
	}
	const r = validator.safeParse(config);
	if (!r.success)
		throw new Failure(
			"validation_failed",
			"the settings do not match the plugin's form",
			r.error.issues,
		);
	return config;
}
