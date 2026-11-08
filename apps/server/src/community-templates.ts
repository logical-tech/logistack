import { Template, type TemplateSummary } from "@logistack/contracts";
import { verifyIndexResponse } from "@logistack/core";
import { communityTemplateIndex, type Db } from "@logistack/db";
import { catalogIndex, readTemplate } from "@logistack/templates";
import { eq } from "drizzle-orm";
import type { Config } from "./config.ts";
import { Failure } from "./errors.ts";

// Community templates (docs/plans/plugins.md, phase 0): a signed index of templates in the
// release's own schema, fetched only on an explicit Refresh and cached in Postgres. Same
// envelope and check as the plugin index (`verifyIndexResponse`); the payload is the list of
// templates. Data only: a community template deploys through the same planner as a built-in one.

const MAX_INDEX_BYTES = 5 * 1024 * 1024;

type Deps = { db: Db; config: Config };

/** The host shown as a community template's source and kept in its provenance. */
export const indexSource = (url: string) => new URL(url).hostname;

/** Fetches, verifies and caches the index. Throws a 400 Failure the caller can show. */
export async function refreshCommunityIndex({ db, config }: Deps) {
	const url = config.LS_TEMPLATE_INDEX_URL;
	const keys = config.LS_TEMPLATE_INDEX_KEYS.split(",")
		.map((k) => k.trim())
		.filter(Boolean);
	if (!keys.length)
		throw new Failure(
			"validation_failed",
			"no public key for the community index: set LS_TEMPLATE_INDEX_KEYS",
		);
	let payload: unknown;
	let keyId: string;
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(15_000),
			redirect: "error",
		});
		if (!res.ok) throw new Error(`the index answered ${res.status}`);
		const body = await res.arrayBuffer();
		if (body.byteLength > MAX_INDEX_BYTES)
			throw new Error("the index is larger than 5 MB");
		const check = await verifyIndexResponse(
			new TextDecoder().decode(body),
			keys,
		);
		if (!check.ok)
			throw new Error(
				check.reason === "unknown_key"
					? "it is signed with a key this instance does not trust"
					: check.reason === "signature"
						? "the signature does not verify"
						: "it is not a signed index",
			);
		payload = check.payload;
		keyId = check.keyId;
	} catch (e) {
		throw new Failure(
			"validation_failed",
			`could not refresh the community index: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!Array.isArray(payload))
		throw new Failure(
			"validation_failed",
			"the community index payload is not a list of templates",
		);
	const builtIn = new Set(catalogIndex().map((t) => t.id));
	const templates: Template[] = [];
	let skipped = 0;
	for (const raw of payload) {
		const t = Template.safeParse(raw);
		if (
			!t.success ||
			builtIn.has(t.data.id) ||
			templates.some((x) => x.id === t.data.id)
		) {
			skipped += 1;
			continue;
		}
		// A logo names a file of our catalog; a community entry gets a monogram.
		const { logo: _, ...rest } = t.data;
		templates.push({
			...rest,
			source: { ...t.data.source, kind: "community" },
		});
	}
	const row = { url, keyId, templates, skipped, fetchedAt: new Date() };
	await db
		.insert(communityTemplateIndex)
		.values(row)
		.onConflictDoUpdate({ target: communityTemplateIndex.url, set: row });
	return row;
}

/** The cached copy of the configured index, or undefined before the first Refresh. */
export async function communityIndex({ db, config }: Deps) {
	const [row] = await db
		.select()
		.from(communityTemplateIndex)
		.where(eq(communityTemplateIndex.url, config.LS_TEMPLATE_INDEX_URL));
	return row;
}

export async function communitySummaries(
	deps: Deps,
): Promise<TemplateSummary[]> {
	const row = await communityIndex(deps);
	if (!row) return [];
	const source = indexSource(row.url);
	return row.templates.map((t) => ({
		id: t.id,
		name: t.name,
		description: t.description,
		category: t.category,
		tags: t.tags,
		source: t.source.kind,
		services: t.services.length,
		community: { source },
	}));
}

/** A built-in template, else one from the cached community index with its source host. */
export async function findTemplate(
	deps: Deps,
	id: string,
): Promise<{ template: Template; community?: string } | undefined> {
	const builtIn = readTemplate(id);
	if (builtIn) return { template: builtIn };
	const row = await communityIndex(deps);
	const t = row?.templates.find((x) => x.id === id);
	return t && row
		? { template: t, community: indexSource(row.url) }
		: undefined;
}
