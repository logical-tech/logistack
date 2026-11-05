import type {
	MigrationItemStatus,
	MigrationSource,
} from "@logistack/contracts";

/**
 * What differs between the platforms a migration can come from, as far as pure code cares: the
 * name people know it by, and how its proxy reads routers while a moved service is bridged.
 * Docker object names (its proxy, network, own containers) are worker settings, overridable for
 * tests.
 */
export const sourceProfiles: Record<
	MigrationSource,
	{ label: string; router: RouterFlavor }
> = {
	dokploy: { label: "Dokploy", router: "traefik-swarm" },
	coolify: { label: "Coolify", router: "traefik-docker" },
};

/**
 * How the old proxy learns routers to a bridged service: Dokploy's Traefik reads Swarm service
 * labels (entrypoints `web`/`websecure`), Coolify's reads container labels through the docker
 * provider (entrypoints `http`/`https`). Both name their ACME resolver `letsencrypt`.
 */
export type RouterFlavor = "traefik-swarm" | "traefik-docker";

/**
 * One item of a migration: `planned → imported → cut_over`. A failed import can be retried; a
 * failed cutover rolls back to the source and can be tried again. Skipping is the user's call and
 * can be undone until the item is cut over.
 */
export type MigrationItemEvent =
	| { type: "imported" }
	| { type: "import_failed" }
	| { type: "cut_over" }
	| { type: "rolled_back" }
	| { type: "skip" }
	| { type: "unskip" };

const transitions: Record<
	MigrationItemStatus,
	Partial<Record<MigrationItemEvent["type"], MigrationItemStatus>>
> = {
	planned: { imported: "imported", import_failed: "failed", skip: "skipped" },
	failed: { imported: "imported", import_failed: "failed", skip: "skipped" },
	imported: {
		cut_over: "cut_over",
		rolled_back: "rolled_back",
		skip: "skipped",
	},
	rolled_back: {
		cut_over: "cut_over",
		rolled_back: "rolled_back",
		skip: "skipped",
	},
	cut_over: { rolled_back: "rolled_back" },
	skipped: { unskip: "planned" },
};

export function migrationItemTransition(
	from: MigrationItemStatus,
	event: MigrationItemEvent,
):
	| { ok: true; state: MigrationItemStatus }
	| {
			ok: false;
			error: {
				code: "illegal_transition";
				from: MigrationItemStatus;
				event: MigrationItemEvent["type"];
			};
	  } {
	const state = transitions[from][event.type];
	return state
		? { ok: true, state }
		: {
				ok: false,
				error: { code: "illegal_transition", from, event: event.type },
			};
}

/** Statuses the import still has to work on. */
export const importable = (s: MigrationItemStatus) =>
	s === "planned" || s === "failed";

/** Why a decommission must not run yet, or undefined when it may. */
export function decommissionBlocker(
	items: { status: string }[],
	proxySwitched: boolean,
	source: MigrationSource = "dokploy",
): string | undefined {
	const label = sourceProfiles[source].label;
	const open = items.filter(
		(i) => i.status !== "cut_over" && i.status !== "skipped",
	).length;
	if (open)
		return `${open} item(s) are neither on LogiStack nor left on ${label}`;
	if (!proxySwitched) return `traffic still goes through ${label}'s proxy`;
	return undefined;
}

/**
 * Where a migration item runs on its source, by exact name or the source's own labels only, so
 * the cutover never matches anything else. Stored in the plan; the worker knows no platform.
 */
export type SourceDescriptor = {
	/** Swarm services by exact name. */
	services?: string[];
	/** Swarm services of a stack, by `com.docker.stack.namespace`. */
	stack?: string;
	/** Containers carrying every one of these `key=value` labels. */
	containerLabels?: string[];
	/**
	 * The source's proxy routes this item's domains by labels on its own containers: keep them
	 * running until that proxy has seen the bridge routers on the moved services.
	 */
	routedByLabels?: boolean;
};

/** The descriptor of a Dokploy item planned before descriptors were stored. */
export const dokployDescriptor = (
	kind: string,
	appName: string,
	hasDomains: boolean,
): SourceDescriptor =>
	kind === "compose"
		? {
				stack: appName,
				containerLabels: [`com.docker.compose.project=${appName}`],
				routedByLabels: hasDomains,
			}
		: { services: [appName] };
