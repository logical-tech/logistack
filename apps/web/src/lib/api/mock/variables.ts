import type { ScopedVar, SharedScope, VariablesApi } from "../variables";
import type { MockDb } from "./fixtures";

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const rid = () => `env_${Math.random().toString(36).slice(2, 10)}`;
const delay = <T>(value: T, ms = 200 + Math.random() * 300): Promise<T> =>
	new Promise((r) => setTimeout(() => r(structuredClone(value)), ms));

/** Organization, project and environment variables, seeded on first read so every scope has some. */
export function variablesStore(db: MockDb) {
	const store = new Map<string, ScopedVar[]>();
	const v = (
		scope: SharedScope,
		scopeId: string,
		key: string,
		value: string,
		isSecret = false,
	): ScopedVar => ({
		id: rid(),
		scope,
		scopeId,
		key,
		value,
		isSecret,
		secretId: null,
		asFile: false,
		isBuildTime: key.startsWith("NEXT_PUBLIC_"),
		createdAt: iso(86_400_000 * 20),
		updatedAt: iso(86_400_000 * 2),
	});
	const seed = (scope: SharedScope, id: string): ScopedVar[] => {
		if (scope === "organization")
			return [
				v(scope, id, "LOG_LEVEL", "info"),
				v(scope, id, "SENTRY_DSN", "https://abc@sentry.logical.it/4"),
			];
		if (scope === "project") {
			const name = db.projects.find((p) => p.id === id)?.name ?? "App";
			return [v(scope, id, "NEXT_PUBLIC_SHOP_NAME", name)];
		}
		const env = db.environments.find((e) => e.id === id);
		const slug = env?.slug ?? "production";
		return [
			v(scope, id, "LOG_LEVEL", env?.kind === "production" ? "warn" : "debug"),
			v(scope, id, "DATABASE_HOST", `db.${slug}.internal`),
		];
	};
	const get = (scope: SharedScope, scopeId: string) => {
		const key = `${scope}:${scopeId}`;
		let list = store.get(key);
		if (!list) {
			list = seed(scope, scopeId);
			store.set(key, list);
		}
		return list;
	};
	const set = (scope: SharedScope, scopeId: string, list: ScopedVar[]) =>
		store.set(
			`${scope}:${scopeId}`,
			list.sort((a, b) => a.key.localeCompare(b.key)),
		);
	const api: VariablesApi = {
		list: async (scope, scopeId) => delay(get(scope, scopeId)),
		replace: async (scope, scopeId, variables) => {
			const previous = get(scope, scopeId);
			set(
				scope,
				scopeId,
				variables.map((input) => {
					const prev = previous.find((p) => p.key === input.key);
					return {
						...(prev ?? v(scope, scopeId, input.key, "")),
						...input,
						value: input.value ?? prev?.value ?? null,
						secretId: null,
						updatedAt: iso(),
					};
				}),
			);
			return delay(undefined);
		},
	};
	return { get, set, api };
}
export type VariablesStore = ReturnType<typeof variablesStore>;
