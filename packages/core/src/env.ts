import { type EnvVarScope, envVarScopes } from "@logistack/contracts";

/** A decrypted env var as stored at one scope. */
export type ScopedEnvVar = {
	scope: EnvVarScope;
	key: string;
	value: string;
	isSecret: boolean;
	isBuildTime: boolean;
	/** Set for an external secret: what spec snapshots record instead of the value. */
	snapshotValue?: string;
};

/** The winning definition of a key, and the scope it came from. */
export type ResolvedEnvVar = Omit<ScopedEnvVar, "key">;

/**
 * Resolves the vars that apply to one service (its org, project, environment and own
 * scope). The most specific scope wins per key; flags come with the winning value.
 */
export function resolveEnv(
	vars: readonly ScopedEnvVar[],
): Record<string, ResolvedEnvVar> {
	const rank = (s: EnvVarScope) => envVarScopes.indexOf(s);
	const sorted = [...vars].sort((a, b) => rank(a.scope) - rank(b.scope));
	const out: Record<string, ResolvedEnvVar> = {};
	for (const { key, ...rest } of sorted) out[key] = rest;
	return out;
}
