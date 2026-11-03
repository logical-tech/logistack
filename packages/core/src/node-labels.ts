/**
 * Node labels install.sh sets on the node itself (`--no-ingress` / `--enable-ingress`, the data
 * node). Swarm owns them: the DB mirrors them and the API never pushes them.
 */
export const SYSTEM_NODE_LABELS: readonly string[] = [
	"logistack.ingress",
	"logistack.data",
];

/** A node's labels: the user's from `desired` (DB or API input), the system ones as `actual` has them. */
export function nodeLabels(
	desired: Record<string, string>,
	actual: Record<string, string>,
): Record<string, string> {
	const out = Object.fromEntries(
		Object.entries(desired).filter(([k]) => !SYSTEM_NODE_LABELS.includes(k)),
	);
	for (const k of SYSTEM_NODE_LABELS)
		if (actual[k] !== undefined) out[k] = actual[k];
	return out;
}
