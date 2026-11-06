import { type SecretScope, secretScopes } from "@logistack/contracts";
import type { Resource } from "./permissions.ts";

/** The scopes whose secrets a resource can reference, least specific first. */
export function secretChain(r: Resource): [SecretScope, string][] {
	const out: [SecretScope, string][] = [["organization", r.organizationId]];
	for (const f of r.folderIds ?? []) out.push(["folder", f]);
	if (r.projectId) out.push(["project", r.projectId]);
	if (r.environmentId) out.push(["environment", r.environmentId]);
	if (r.serviceId) out.push(["service", r.serviceId]);
	return out;
}

/** Whether a secret defined at (scope, scopeId) is visible from `r`. */
export const secretInChain = (
	s: { scope: SecretScope; scopeId: string },
	r: Resource,
) => secretChain(r).some(([k, id]) => k === s.scope && id === s.scopeId);

/** Rank of a secret in a chain: higher is more specific. Folders rank by depth. */
export function secretRank(
	s: { scope: SecretScope; scopeId: string },
	chain: readonly [SecretScope, string][],
): number {
	const i = chain.findIndex(([k, id]) => k === s.scope && id === s.scopeId);
	return i < 0 ? -1 : i;
}

/** Marks every secret that a more specific scope in the chain shadows with the same key. */
export function markShadowed<
	T extends { scope: SecretScope; scopeId: string; key: string },
>(
	secrets: readonly T[],
	chain: readonly [SecretScope, string][],
): (T & { shadowed: boolean })[] {
	return secrets.map((s) => ({
		...s,
		shadowed: secrets.some(
			(o) => o.key === s.key && secretRank(o, chain) > secretRank(s, chain),
		),
	}));
}

export const secretScopeRank = (s: SecretScope) => secretScopes.indexOf(s);

/**
 * Returns a function that replaces every occurrence of a secret value (and its base64 form)
 * with `***`. Values shorter than 4 characters are left alone: masking "1" would garble logs.
 */
export function secretMasker(
	values: Iterable<string>,
): (text: string) => string {
	const needles = [
		...new Set(
			[...values]
				.filter((v) => v.length >= 4)
				.flatMap((v) => [v, Buffer.from(v).toString("base64")]),
		),
	].sort((a, b) => b.length - a.length);
	if (!needles.length) return (t) => t;
	return (text) => {
		let out = text;
		for (const n of needles) out = out.replaceAll(n, "***");
		return out;
	};
}
