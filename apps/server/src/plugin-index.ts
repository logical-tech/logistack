import type {
	PluginIndexEntry,
	PluginIndexVersion,
} from "@logistack/contracts";
import {
	PLUGIN_INDEX_KEYS,
	PLUGIN_INDEX_URL,
	readPluginDetail,
	readPluginIndex,
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
import type { Config } from "./config.ts";
import type { Deps } from "./env.ts";
import { Failure, notFound } from "./errors.ts";
import { devFetch } from "./plugins.ts";

// Marketplace indexes on the server side (plugin-index/README.md for the format): fetching and
// verifying signed responses, the cache in `plugin_index`, and yanked flags. Fetches happen only
// on an explicit refresh, when someone opens the marketplace with a stale cache, or when an
// install, update or the update dialog needs a plugin's versions and they are not cached.

export type IndexRow = typeof pluginIndex.$inferSelect;

export const OFFICIAL_INDEX_ID = "pidx_official";
/** The official index's sandbox, used with LOGISTACK_PLUGIN_INDEX_SANDBOX=1. */
export const PLUGIN_INDEX_SANDBOX_URL =
	"https://stack.logicaltech.it/plugins/sandbox-api";
/** The marketplace refreshes an index on open once its cache is older than this. */
export const INDEX_STALE_MS = 3_600_000;

/** `a,b` (LS_PLUGIN_INDEX_PUBLIC_KEY) to a key list. */
const keyList = (v: string) =>
	v
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean);

/**
 * The official index as this server's config defines it. Its keys are `PLUGIN_INDEX_KEYS`
 * (empty until a release bundles the production key) plus LS_PLUGIN_INDEX_PUBLIC_KEY.
 */
export function officialIndex(config: Config) {
	const sandbox = config.LOGISTACK_PLUGIN_INDEX_SANDBOX;
	return {
		url: sandbox ? PLUGIN_INDEX_SANDBOX_URL : PLUGIN_INDEX_URL,
		name: sandbox ? "LogiStack (sandbox)" : "LogiStack",
		publicKeys: [
			...new Set([
				...PLUGIN_INDEX_KEYS,
				...keyList(config.LS_PLUGIN_INDEX_PUBLIC_KEY ?? ""),
			]),
		],
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

/** GETs `path` from an index through the SSRF guard and returns its verified payload. */
async function fetchVerified(
	db: Db,
	index: Pick<IndexRow, "url" | "publicKeys">,
	path: string,
): Promise<unknown> {
	if (!index.publicKeys.length)
		throw new Failure(
			"conflict",
			"no public key is configured for this index; set LS_PLUGIN_INDEX_PUBLIC_KEY",
		);
	const f = await devFetch(db);
	const res = await f(`${index.url.replace(/\/+$/, "")}${path}`, {
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
	const check = await verifyIndexResponse(await res.text(), index.publicKeys);
	if (!check.ok)
		throw new Failure(
			"bad_request",
			check.reason === "unknown_key"
				? "the index signed with a key this instance does not trust"
				: check.reason === "signature"
					? "the index response has a bad signature"
					: "the index answered without a valid signed envelope",
		);
	return check.payload;
}

/** `GET /v1/index`, verified; entries this server cannot read are skipped. */
export async function fetchIndex(
	db: Db,
	index: Pick<IndexRow, "url" | "publicKeys">,
) {
	const r = readPluginIndex(await fetchVerified(db, index, "/v1/index"));
	if (!r)
		throw new Failure(
			"bad_request",
			"the index response does not match the index contract",
		);
	return r;
}

/** `GET /v1/plugins/{id}`, verified and checked to be about `pluginId`. */
export async function fetchDetail(
	db: Db,
	index: Pick<IndexRow, "url" | "publicKeys">,
	pluginId: string,
) {
	const r = readPluginDetail(
		await fetchVerified(
			db,
			index,
			`/v1/plugins/${encodeURIComponent(pluginId)}`,
		),
		pluginId,
	);
	if (!r)
		throw new Failure(
			"bad_request",
			"the index answered about another plugin, or not in the index contract",
		);
	return r.plugin;
}

/** The version a listing shows: the newest, else the newest verified one. */
export const shownVersion = (e: PluginIndexEntry) =>
	e.latest ?? e.latestVerified;

/**
 * Fetches the listing, caches it, and flags installs whose version the index yanked (from the
 * listing's `yanked` list). A failure keeps the old cache and is stored as `last_error`. Cached
 * versions are dropped, so the next update dialog sees new releases.
 */
export async function refreshIndex(db: Db, row: IndexRow): Promise<IndexRow> {
	try {
		const index = await fetchIndex(db, row);
		const entries: PluginIndexCache = index.plugins;
		const installs = await db
			.select({
				id: pluginInstall.id,
				pluginId: pluginInstall.pluginId,
				version: pluginInstall.version,
			})
			.from(pluginInstall)
			.where(eq(pluginInstall.indexId, row.id));
		for (const i of installs) {
			const yanked =
				entries
					.find((e) => e.id === i.pluginId)
					?.yanked.some((y) => y.version === i.version) ?? false;
			await db
				.update(pluginInstall)
				.set({ yanked })
				.where(
					and(eq(pluginInstall.id, i.id), ne(pluginInstall.yanked, yanked)),
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

/** Every listed version of a plugin, newest first: cached, else fetched now and cached. */
export async function pluginVersions(
	db: Db,
	row: IndexRow,
	pluginId: string,
): Promise<PluginIndexVersion[]> {
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

/** One version as the index signed it; the listing's latest ones need no extra fetch. */
export async function indexVersion(
	db: Db,
	row: IndexRow,
	pluginId: string,
	version: string,
): Promise<PluginIndexVersion> {
	const entry = row.entries.find((e) => e.id === pluginId);
	const listed = [entry?.latest, entry?.latestVerified].find(
		(v) => v?.version === version,
	);
	if (listed && !entry?.versions) return listed;
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

/** Opt-in, anonymous (`POST /v1/ping`): the plugin id and the install's random id, nothing about the instance. */
export async function pingInstall(
	deps: Pick<Deps, "db">,
	row: IndexRow,
	pluginId: string,
	installId: string,
) {
	const [s] = await deps.db
		.select({ on: instanceSettings.pluginInstallPing })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	if (!s?.on) return;
	const f = await devFetch(deps.db);
	await f(`${row.url.replace(/\/+$/, "")}/v1/ping`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ pluginId, installId }),
		signal: AbortSignal.timeout(5_000),
	}).catch(() => {});
}
