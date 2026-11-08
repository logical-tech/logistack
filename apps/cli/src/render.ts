import type { ManifestChange } from "@logistack/contracts";

const sign = { create: "+", update: "~", delete: "-" } as const;

/** One line per change, plus its details indented; `color` adds ANSI green, yellow and red. */
export function renderChanges(
	changes: readonly ManifestChange[],
	color = false,
): string {
	if (!changes.length) return "No changes.";
	const paint = (op: ManifestChange["op"], s: string) =>
		!color
			? s
			: `\x1b[${op === "create" ? 32 : op === "update" ? 33 : 31}m${s}\x1b[0m`;
	const lines: string[] = [];
	for (const c of changes) {
		const where = [c.environment, c.service, c.name].filter(Boolean).join("/");
		lines.push(paint(c.op, `${sign[c.op]} ${c.resource} ${where}`));
		for (const d of c.changes) lines.push(`    ${d}`);
	}
	const count = (op: ManifestChange["op"]) =>
		changes.filter((c) => c.op === op).length;
	lines.push(
		"",
		`${count("create")} to create, ${count("update")} to change, ${count("delete")} to delete.`,
	);
	return lines.join("\n");
}
