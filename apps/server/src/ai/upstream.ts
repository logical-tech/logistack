import {
	type AiProviderDef,
	type AiTier,
	aiProvider,
	decrypt,
	type ModelRef,
	servedModels,
	upstreamAuth,
} from "@logistack/core";
import { aiProviderKey, type Db } from "@logistack/db";
import { eq } from "drizzle-orm";
import { redisFor } from "../redis.ts";
import { hostPolicy, resolvePublic } from "../ssrf.ts";

export type ProviderKey = typeof aiProviderKey.$inferSelect;

export type Candidate = {
	key: ProviderKey;
	def: AiProviderDef;
	model: string;
	tier: AiTier;
};

const shuffle = <T>(xs: T[]) =>
	xs
		.map((x) => [Math.random(), x] as const)
		.sort((a, b) => a[0] - b[0])
		.map(([, x]) => x);

/** The model `auto` tries on a key: its provider's default when served, else the first it lists. */
function autoModel(key: ProviderKey, def: AiProviderDef): string | undefined {
	if (
		def.defaultModel &&
		(!key.models.length || key.models.includes(def.defaultModel))
	)
		return def.defaultModel;
	return key.models[0];
}

/**
 * Upstream attempts for a model ref, best first. Keys of one provider are shuffled so load
 * spreads across them; `auto` walks the configured chain, else every free provider's default.
 */
export function candidates(
	keys: ProviderKey[],
	ref: ModelRef,
	tiers: Set<AiTier>,
	autoChain: string[],
): Candidate[] {
	const usable = keys.flatMap((key) => {
		const def = aiProvider(key.provider);
		return def &&
			key.enabled &&
			key.status !== "unhealthy" &&
			tiers.has(def.tier)
			? [{ key, def }]
			: [];
	});
	const byProvider = (provider: string) =>
		shuffle(usable.filter((u) => u.def.id === provider));
	switch (ref.kind) {
		case "pinned":
			return byProvider(ref.provider).map((u) => ({
				...u,
				model: ref.model,
				tier: u.def.tier,
			}));
		case "any":
			return shuffle(
				usable.filter((u) => u.key.models.includes(ref.model)),
			).map((u) => ({ ...u, model: ref.model, tier: u.def.tier }));
		case "auto": {
			const free = usable.filter((u) => u.def.tier === "free");
			if (autoChain.length)
				return autoChain.flatMap((entry) => {
					const slash = entry.indexOf("/");
					const provider = entry.slice(0, slash);
					const model = entry.slice(slash + 1);
					return shuffle(free.filter((u) => u.def.id === provider)).map(
						(u) => ({ ...u, model, tier: u.def.tier }),
					);
				});
			return shuffle(free).flatMap((u) => {
				const model = autoModel(u.key, u.def);
				return model ? [{ ...u, model, tier: u.def.tier }] : [];
			});
		}
	}
}

const coolKey = (keyId: string, model: string) =>
	`ls:ai:cool:${keyId}:${model}`;

/** Skips a key and model for a while after a 429 or an outage; shared by every replica. */
export async function coolDown(
	redisUrl: string,
	c: Candidate,
	seconds: number,
) {
	await redisFor(redisUrl).send("SET", [
		coolKey(c.key.id, c.model),
		"1",
		"EX",
		String(Math.max(1, Math.min(seconds, 3_600))),
	]);
}

export async function isCooling(redisUrl: string, c: Candidate) {
	return (await redisFor(redisUrl).exists(coolKey(c.key.id, c.model))) === true;
}

/** Base URL and auth headers for a key, with a custom server's host checked like any user-given URL. */
export async function endpointFor(
	db: Db,
	masterKey: CryptoKey,
	key: ProviderKey,
	def: AiProviderDef,
) {
	const secret = await decrypt(masterKey, key.secretEncrypted);
	const auth = upstreamAuth(def, secret, key.baseUrl);
	if (def.customBaseUrl) {
		// shortcut: the address is checked, not pinned, so DNS rebinding can still slip through; pin it like guardedFetch if custom servers are exposed to untrusted admins.
		await resolvePublic(new URL(auth.baseUrl).hostname, await hostPolicy(db));
	}
	return auth;
}

/** Lists a key's models and records whether it works. */
export async function testKey(
	db: Db,
	masterKey: CryptoKey,
	key: ProviderKey,
): Promise<ProviderKey> {
	const def = aiProvider(key.provider);
	if (!def) throw new Error(`unknown provider ${key.provider}`);
	let models: string[] = [];
	let error: string | null = null;
	try {
		const { baseUrl, headers } = await endpointFor(db, masterKey, key, def);
		if (def.staticModels) {
			// No usable listing: a one-token call proves the key.
			const res = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({
					model: def.defaultModel,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
				}),
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok) throw new Error(await failureText(res));
		} else {
			const res = await fetch(`${baseUrl}/models`, {
				headers,
				signal: AbortSignal.timeout(15_000),
			});
			if (!res.ok) throw new Error(await failureText(res));
			const body = (await res.json()) as { data?: { id: string }[] };
			models = (body.data ?? []).map((m) => m.id);
		}
		models = servedModels(def, models);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	const [row] = await db
		.update(aiProviderKey)
		.set({
			status: error ? "unhealthy" : "healthy",
			lastError: error,
			lastCheckedAt: new Date(),
			...(error ? {} : { models }),
		})
		.where(eq(aiProviderKey.id, key.id))
		.returning();
	return row ?? key;
}

/** A provider's error as one short line, its key never echoed. */
export async function failureText(res: Response): Promise<string> {
	const raw = await res.text().catch(() => "");
	let message = raw;
	try {
		const body = JSON.parse(raw);
		message =
			body?.error?.message ??
			body?.message ??
			body?.detail ??
			JSON.stringify(body);
	} catch {}
	return `${res.status} ${String(message).slice(0, 300)}`.trim();
}
