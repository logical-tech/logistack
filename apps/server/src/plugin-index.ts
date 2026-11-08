import {
	PluginDetailPayload,
	type PluginDetailVersion,
	PluginIndexEnvelope,
	PluginIndexPayload,
} from "@logistack/contracts";
import {
	OFFICIAL_PLUGIN_INDEX_KEYS,
	OFFICIAL_PLUGIN_INDEX_SANDBOX_URL,
	OFFICIAL_PLUGIN_INDEX_URL,
	parsePublicKeys,
	verifyIndexResponse,
} from "@logistack/core";
import {
	type Db,
	instanceSettings,
	type PluginIndexCache,
	pluginIndex,
	pluginInstall,
} from "@logistack/db";
import { and, eq, ne } from "drizzle-orm";
import type { z } from "zod";
import type { Config } from "./config.ts";
import type { Deps } from "./env.ts";
import { Failure, notFound } from "./errors.ts";
import { devFetch } from "./plugins.ts";

// Marketplace indexes on the server side: fetching and verifying signed responses, the cache in
// `plugin_index`, and yanked flags. Fetches happen only on an explicit refresh, when someone opens
// the marketplace with a stale cache, or when an install or update needs a version not cached.

export type IndexRow = typeof pluginIndex.$inferSelect;

export const OFFICIAL_INDEX_ID = "pidx_official";
/** The marketplace refreshes an index on open once its cache is older than this. */
export const INDEX_STALE_MS = 3_600_000;

/** The official index as this server's config defines it. */
export function officialIndex(config: Config) {
	const keys = config.LS_PLUGIN_INDEX_PUBLIC_KEY
		? parsePublicKeys(config.LS_PLUGIN_INDEX_PUBLIC_KEY)
		: OFFICIAL_PLUGIN_INDEX_KEYS;
	return {
		url: config.LOGISTACK_PLUGIN_INDEX_SANDBOX
			? OFFICIAL_PLUGIN_INDEX_SANDBOX_URL
			: OFFICIAL_PLUGIN_INDEX_URL,
		name: config.LOGISTACK_PLUGIN_INDEX_SANDBOX
			? "LogiStack (sandbox)"
			: "LogiStack",
		publicKeys: keys,
	};
}

/** The official index's row, kept in step with the config (its URL and keys can change on a release). */
export async function ensureOfficialIndex(db: Db, config: Config) {
	const o = officialIndex(config);
	await db
		.insert(pluginIndex)
		.values({ id: OFFICIAL_INDEX_ID, builtin: true, ...o })
		.onConflictDoUpdate({
			target: pluginIndex.id,
			set: { url: o.url, publicKeys: o.publicKeys },
		});
}

export async function indexRow(db: Db, id: string): Promise<IndexRow> {
	const [row] = await db
		.select()
		.from(pluginIndex)
		.where(eq(pluginIndex.id, id));
	if (!row) throw notFound("plugin index");
	return row;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** GETs `path` from an index through the SSRF guard and returns its verified, parsed payload. */
export async function fetchSigned<S extends z.ZodType>(
	db: Db,
	index: Pick<IndexRow, "url" | "publicKeys">,
	path: string,
	schema: S,
): Promise<z.infer<S>> {
	const f = await devFetch(db);
	const url = `${index.url.replace(/\/+$/, "")}${path}`;
	const res = await f(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
		redirect: "manual",
	}).catch((e: unknown) => {
		throw new Failure("bad_request", `could not reach the index: ${errMsg(e)}`);
	});
	if (res.status === 404 && path !== "/v1/index")
		throw new Failure("not_found", `the index has nothing at ${path}`);
	if (!res.ok)
		throw new Failure("bad_request", `the index answered ${res.status}`);
	const envelope = PluginIndexEnvelope.safeParse(
		await res.json().catch(() => null),
	);
	if (!envelope.success)
		throw new Failure(
			"bad_request",
			"the index answered without a signed envelope",
		);
	const check = await verifyIndexResponse(envelope.data, index.publicKeys);
	if (!check.ok)
		throw new Failure(
			"bad_request",
			check.reason === "unknown_key"
				? `the index signed with key '${envelope.data.keyId}', which this instance does not trust`
				: check.reason === "signature"
					? "the index response has a bad signature"
					: "the index response is not JSON",
		);
	const parsed = schema.safeParse(check.payload);
	if (!parsed.success)
		throw new Failure(
			"bad_request",
			"the index response does not match the index contract",
			parsed.error.issues,
		);
	return parsed.data;
}

export const fetchDetail = (
	db: Db,
	index: Pick<IndexRow, "url" | "publicKeys">,
	pluginId: string,
) =>
	fetchSigned(
		db,
		index,
		`/v1/plugins/${encodeURIComponent(pluginId)}`,
		PluginDetailPayload,
	);

/**
 * Fetches the listing, plus every version of each plugin installed from this index (for updates
 * and yanked flags), caches both, and flags installs whose version the index yanked. A failure
 * keeps the old cache and is stored as `last_error`.
 */
export async function refreshIndex(db: Db, row: IndexRow): Promise<IndexRow> {
	try {
		// Nothing could verify the answer: do not fetch (the official index before a release bundles its key).
		if (!Object.values(row.publicKeys).some(Boolean))
			throw new Failure(
				"conflict",
				"no public key is configured for this index; set LS_PLUGIN_INDEX_PUBLIC_KEY",
			);
		const index = await fetchSigned(db, row, "/v1/index", PluginIndexPayload);
		const installs = await db
			.select({
				id: pluginInstall.id,
				pluginId: pluginInstall.pluginId,
				version: pluginInstall.version,
			})
			.from(pluginInstall)
			.where(eq(pluginInstall.indexId, row.id));
		const details = new Map<string, PluginDetailVersion[]>();
		for (const pluginId of new Set(installs.map((i) => i.pluginId)))
			details.set(
				pluginId,
				await fetchDetail(db, row, pluginId)
					.then((d) => d.versions)
					.catch((e: unknown) => {
						// A plugin the index dropped has no versions to offer.
						if (e instanceof Failure && e.code === "not_found") return [];
						throw e;
					}),
			);
		const entries: PluginIndexCache = index.plugins.map((p) => ({
			...p,
			...(details.has(p.id) ? { versions: details.get(p.id) } : {}),
		}));
		for (const i of installs) {
			const v = details.get(i.pluginId)?.find((x) => x.version === i.version);
			await db
				.update(pluginInstall)
				.set({ yanked: v?.yanked ?? false })
				.where(
					and(
						eq(pluginInstall.id, i.id),
						ne(pluginInstall.yanked, v?.yanked ?? false),
					),
				);
		}
		const [updated] = await db
			.update(pluginIndex)
			.set({ entries, fetchedAt: new Date(), lastError: null })
			.where(eq(pluginIndex.id, row.id))
			.returning();
		return updated ?? row;
	} catch (e) {
		await db
			.update(pluginIndex)
			.set({ lastError: errMsg(e) })
			.where(eq(pluginIndex.id, row.id));
		throw e;
	}
}

/** Every version of a plugin: cached by the last refresh, else fetched now and cached. */
export async function pluginVersions(
	db: Db,
	row: IndexRow,
	pluginId: string,
): Promise<PluginDetailVersion[]> {
	const entry = row.entries.find((e) => e.id === pluginId);
	if (entry?.versions) return entry.versions;
	const { versions } = await fetchDetail(db, row, pluginId);
	if (entry)
		await db
			.update(pluginIndex)
			.set({
				entries: row.entries.map((e) =>
					e.id === pluginId ? { ...e, versions } : e,
				),
			})
			.where(eq(pluginIndex.id, row.id));
	return versions;
}

/** One version as the index signed it. */
export async function indexVersion(
	db: Db,
	row: IndexRow,
	pluginId: string,
	version: string,
): Promise<PluginDetailVersion> {
	const entry = row.entries.find((e) => e.id === pluginId);
	if (entry?.latest.version === version && !entry.versions)
		return { ...entry.latest, verified: entry.verified };
	const v = (await pluginVersions(db, row, pluginId)).find(
		(x) => x.version === version,
	);
	if (!v)
		throw new Failure(
			"not_found",
			`${pluginId} ${version} is not in this index`,
		);
	return v;
}

/** Opt-in, anonymous: the plugin id and version, nothing about the instance. Never awaited by callers. */
export async function pingInstall(
	deps: Pick<Deps, "db">,
	row: IndexRow,
	pluginId: string,
	version: string,
) {
	const [s] = await deps.db
		.select({ on: instanceSettings.pluginInstallPing })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	if (!s?.on) return;
	const f = await devFetch(deps.db);
	await f(
		`${row.url.replace(/\/+$/, "")}/v1/plugins/${encodeURIComponent(pluginId)}/installs`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ version }),
			signal: AbortSignal.timeout(5_000),
		},
	).catch(() => {});
}
