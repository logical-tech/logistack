/** Field-level errors from a zod issue list, first message per key. */
export function issuesByKey(
	issues: { path: PropertyKey[]; message: string }[],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const i of issues) out[String(i.path[0])] ??= i.message;
	return out;
}
