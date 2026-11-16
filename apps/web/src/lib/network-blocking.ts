import type { NetworkBlocking } from "@logistack/contracts";

/** Extra rules a device gets: its person's, then its own, without repeats. */
export function effectiveBlocking(
	own: NetworkBlocking,
	person: NetworkBlocking | undefined,
): NetworkBlocking {
	return {
		listUrls: [...new Set([...(person?.listUrls ?? []), ...own.listUrls])],
		blocked: [...new Set([...(person?.blocked ?? []), ...own.blocked])],
	};
}

export const hasBlocking = (b: NetworkBlocking) =>
	b.listUrls.length > 0 || b.blocked.length > 0;
