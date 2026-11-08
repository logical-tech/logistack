import {
	PluginId,
	PluginImageDigestRef,
	PluginManifest,
} from "../../packages/contracts/src/plugin.ts";
import type { Who } from "./auth.ts";
import { type Env, HttpError, newId, now, str } from "./http.ts";
import { checkImage } from "./oci.ts";

/** Only admins may register ids under these. */
export const RESERVED_PREFIXES = ["dev.logistack.", "it.logicaltech."];

const KiB = 1024;

export type Submission = {
	image: string;
	manifest: PluginManifest;
	readme: string;
	changelog: string;
	iconUrl: string | null;
};

/**
 * Checks a version submission without I/O. The manifest is parsed strictly at the top level:
 * the index lists free plugins only, so keys such as `price` or `licenseKey` are refused
 * instead of being silently dropped.
 */
export function validateSubmission(
	pluginId: string,
	body: Record<string, unknown>,
): Submission {
	let raw = body.manifest;
	if (typeof raw === "string") {
		if (raw.length > 64 * KiB)
			throw new HttpError(422, "the manifest is larger than 64 KiB");
		try {
			raw = JSON.parse(raw);
		} catch {
			throw new HttpError(422, "the manifest is not JSON");
		}
	}
	const parsed = PluginManifest.strict().safeParse(raw);
	if (!parsed.success) {
		const unknown = parsed.error.issues.flatMap((i) =>
			i.code === "unrecognized_keys" && i.path.length === 0 ? i.keys : [],
		);
		throw new HttpError(
			422,
			unknown.length
				? `the manifest has unknown top-level keys: ${unknown.join(", ")}. The index takes free plugins only, with no price, payment or license-key fields`
				: "the manifest is invalid",
			parsed.error.issues,
		);
	}
	const manifest = parsed.data;
	if (manifest.id !== pluginId)
		throw new HttpError(
			422,
			`the manifest id is ${manifest.id}, not ${pluginId}`,
		);
	const image = str(body.image, 300);
	if (!PluginImageDigestRef.safeParse(image).success)
		throw new HttpError(
			422,
			"the image must be a digest reference with its registry, as ghcr.io/acme/plugin@sha256:…",
		);
	const readme = str(body.readme, 64 * KiB);
	const changelog = str(body.changelog, 32 * KiB);
	if (readme.length > 64 * KiB)
		throw new HttpError(422, "the README is larger than 64 KiB");
	if (changelog.length > 32 * KiB)
		throw new HttpError(422, "the changelog is larger than 32 KiB");
	const icon = str(body.iconUrl, 500);
	if (icon && (!URL.canParse(icon) || new URL(icon).protocol !== "https:"))
		throw new HttpError(422, "the icon URL must be https");
	return { image, manifest, readme, changelog, iconUrl: icon || null };
}

export async function setPublisherName(env: Env, who: Who, raw: unknown) {
	const name = str(raw, 60).replace(/[\p{Cc}\p{Cf}<>]/gu, "");
	if (!name || name.length > 60)
		throw new HttpError(400, "the publisher name takes 1 to 60 characters");
	await env.PLUGIN_INDEX.prepare("UPDATE publishers SET name = ? WHERE id = ?")
		.bind(name, who.publisher.id)
		.run();
}

function assertActive(who: Who) {
	if (who.publisher.suspended_at)
		throw new HttpError(403, "this publisher account is suspended");
	if (!who.publisher.name)
		throw new HttpError(
			400,
			"set a publisher name first: it is shown on the index",
		);
}

/** First come, first served; reserved prefixes are for admins. */
export async function registerPlugin(env: Env, who: Who, rawId: unknown) {
	assertActive(who);
	const id = str(rawId, 128);
	if (!PluginId.safeParse(id).success)
		throw new HttpError(
			422,
			"the id must be reverse-DNS, lower case, as com.acme.my-plugin",
		);
	if (!who.admin && RESERVED_PREFIXES.some((p) => id.startsWith(p)))
		throw new HttpError(
			403,
			`ids under ${RESERVED_PREFIXES.join(" and ")} are reserved`,
		);
	const res = await env.PLUGIN_INDEX.prepare(
		"INSERT INTO plugins (id, publisher_id, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
	)
		.bind(id, who.publisher.id, now())
		.run();
	if (!res.meta.changes) throw new HttpError(409, `${id} is taken`);
	return { id };
}

/**
 * Stores a version as `pending`, runs the checks a Worker can run, then lists it as
 * `unverified` or marks it `rejected` with the reason. A rejected version may be submitted again.
 */
export async function submitVersion(
	env: Env,
	who: Who,
	pluginId: string,
	body: Record<string, unknown>,
	fetchFn: typeof fetch = fetch,
) {
	assertActive(who);
	const db = env.PLUGIN_INDEX;
	const plugin = await db
		.prepare("SELECT publisher_id FROM plugins WHERE id = ?")
		.bind(pluginId)
		.first<{ publisher_id: string }>();
	if (!plugin || plugin.publisher_id !== who.publisher.id)
		throw new HttpError(404, `you have no plugin ${pluginId}`);
	const s = validateSubmission(pluginId, body);
	const existing = await db
		.prepare("SELECT status FROM versions WHERE plugin_id = ? AND version = ?")
		.bind(pluginId, s.manifest.version)
		.first<{ status: string }>();
	if (existing && existing.status !== "rejected")
		throw new HttpError(
			409,
			`${s.manifest.version} exists; versions are immutable, bump it`,
		);
	const id = newId("ver");
	const t = now();
	await db.batch([
		db
			.prepare(
				"DELETE FROM versions WHERE plugin_id = ? AND version = ? AND status = 'rejected'",
			)
			.bind(pluginId, s.manifest.version),
		db
			.prepare(
				`INSERT INTO versions (id, plugin_id, version, image, manifest, readme, changelog, icon_url, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
			)
			.bind(
				id,
				pluginId,
				s.manifest.version,
				s.image,
				JSON.stringify(s.manifest),
				s.readme,
				s.changelog,
				s.iconUrl,
				t,
				t,
			),
	]);
	const problem = await checkImage(s.image, s.manifest, fetchFn);
	const status = problem ? "rejected" : "unverified";
	await db
		.prepare(
			"UPDATE versions SET status = ?, review_notes = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
		)
		.bind(status, problem ? `automatic check: ${problem}` : "", now(), id)
		.run();
	return { id, version: s.manifest.version, status, notes: problem ?? "" };
}

export type OwnPlugin = {
	id: string;
	versions: {
		id: string;
		version: string;
		image: string;
		status: string;
		review_notes: string;
		created_at: number;
	}[];
};

export async function listOwn(env: Env, who: Who): Promise<OwnPlugin[]> {
	const { results } = await env.PLUGIN_INDEX.prepare(
		`SELECT p.id AS plugin_id, v.id, v.version, v.image, v.status, v.review_notes, v.created_at
		 FROM plugins p LEFT JOIN versions v ON v.plugin_id = p.id
		 WHERE p.publisher_id = ? ORDER BY p.id, v.created_at DESC`,
	)
		.bind(who.publisher.id)
		.all<OwnPlugin["versions"][number] & { plugin_id: string }>();
	const out = new Map<string, OwnPlugin>();
	for (const { plugin_id, ...v } of results) {
		const p = out.get(plugin_id) ?? { id: plugin_id, versions: [] };
		if (v.id) p.versions.push(v);
		out.set(plugin_id, p);
	}
	return [...out.values()];
}
