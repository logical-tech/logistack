/**
 * Pieces every source's inventory shares: how org items and refusals are recorded, the order of a
 * compose split, and the checks across items. Pure; notes name things, never values.
 */
import type { z } from "zod";
import type {
	InventoryItem,
	OrgDraft,
	OrgItem,
	ServiceDraft,
	Status,
} from "./types.ts";

/** Keys whose values are treated as secrets in LogiStack (hidden in the UI). */
export const SENSITIVE =
	/PASS|SECRET|TOKEN|KEY|PRIVATE|CRED|AUTH|SALT|DSN|URL|URI|CONN/i;

export const orgItem = (
	kind: OrgItem["kind"],
	sourceId: string,
	name: string,
	notes: string[],
	draft: OrgDraft | undefined,
): OrgItem => ({
	kind,
	sourceId,
	name,
	notes,
	status: !draft ? "unsupported" : notes.length ? "partial" : "full",
	...(draft && { draft }),
});

/** Zod messages for a body the LogiStack route would refuse, or none. */
export const refused = (schema: z.ZodType, input: unknown, notes: string[]) => {
	const parsed = schema.safeParse(input);
	if (parsed.success) return false;
	notes.push(
		...parsed.error.issues.map(
			(i) => `${i.path.join(".") || "input"}: ${i.message}`,
		),
	);
	return true;
};

/** Drafts so each comes after what it depends on; a cycle or unknown name is reported, order kept. */
export function dependencyOrder(
	drafts: ServiceDraft[],
	notes: string[],
): ServiceDraft[] {
	const by = new Map(drafts.map((d) => [d.slug, d]));
	const out: ServiceDraft[] = [];
	const state = new Map<string, "visiting" | "done">();
	const visit = (d: ServiceDraft) => {
		if (state.get(d.slug) === "done") return;
		if (state.get(d.slug) === "visiting") {
			notes.push(`depends_on cycle through ${d.slug}`);
			return;
		}
		state.set(d.slug, "visiting");
		for (const dep of d.dependsOn) {
			const target = by.get(dep);
			if (target) visit(target);
			else notes.push(`${d.slug} depends on unknown service ${dep}`);
		}
		state.set(d.slug, "done");
		out.push(d);
	};
	for (const d of drafts) visit(d);
	return out;
}

export const statusOf = (item: InventoryItem): Status =>
	!item.services.length
		? "unsupported"
		: item.notes.length
			? "partial"
			: "full";

/**
 * Checks across items. Two services with one slug in one LogiStack environment cannot both exist:
 * the later item is refused. Dokploy puts every service on one shared network, LogiStack isolates
 * environments: an env value naming a service of another environment is reported.
 */
export function crossChecks(items: InventoryItem[]): InventoryItem[] {
	const where = (i: InventoryItem) => `${i.project}\u0000${i.environment}`;
	const taken = new Map<string, string>();
	for (const item of items) {
		const clash = item.services.find((s) =>
			taken.has(`${where(item)}\u0000${s.slug}`),
		);
		if (clash) {
			item.notes.push(
				`hostname ${clash.slug} is already used in this environment by ${taken.get(`${where(item)}\u0000${clash.slug}`)}`,
			);
			item.services = [];
		}
		for (const s of item.services)
			taken.set(`${where(item)}\u0000${s.slug}`, item.name);
	}
	const hosts = items.flatMap((i) =>
		i.services.map((s) => ({ slug: s.slug, at: where(i), item: i.name })),
	);
	for (const item of items)
		for (const s of item.services)
			for (const e of s.env)
				for (const h of hosts)
					if (
						h.at !== where(item) &&
						// Specific enough to look for: Dokploy's `name-abc123`, Coolify's uuids.
						(h.slug.includes("-") || h.slug.length >= 16) &&
						new RegExp(`(^|[^a-z0-9-])${h.slug}([^a-z0-9-]|$)`).test(e.value)
					)
						item.notes.push(
							`env ${e.key} reaches ${h.item} in another environment; LogiStack environments are isolated`,
						);
	for (const item of items) {
		item.notes = [...new Set(item.notes)];
		item.status = statusOf(item);
	}
	return items;
}

/**
 * References from services to organization items: a backup whose destination does not import is
 * dropped, and a git source whose provider does not import must be reconnected.
 */
export function orgChecks(items: InventoryItem[], org: OrgItem[]) {
	const find = (kind: OrgItem["kind"], id: string) =>
		org.find((o) => o.kind === kind && o.sourceId === id);
	for (const item of items) {
		for (const s of item.services) {
			s.backups = s.backups.filter((b) => {
				const destination = find("s3Destination", b.destination);
				if (destination?.draft) return true;
				item.notes.push(
					`backup to ${destination?.name ?? "a missing destination"} is not carried over`,
				);
				return false;
			});
			if (!s.gitProvider) continue;
			const git = find("gitProvider", s.gitProvider.sourceId);
			if (!git?.draft)
				item.notes.push(
					`git provider ${git?.name ?? s.gitProvider.type} must be reconnected in LogiStack`,
				);
		}
		item.notes = [...new Set(item.notes)];
		item.status = statusOf(item);
	}
}
