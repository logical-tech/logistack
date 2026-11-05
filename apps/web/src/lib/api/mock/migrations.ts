import { ApiError } from "../adapter";
import type {
	ItemAction,
	Migration,
	MigrationItem,
	MigrationSource,
	MigrationsApi,
} from "../migrations";

function delay<T>(value: T, ms = 200 + Math.random() * 300): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

type Svc = MigrationItem["services"][number];
const svc = (o: Partial<Svc> & Pick<Svc, "name" | "slug" | "kind">): Svc => ({
	engine: null,
	domains: [],
	running: true,
	stateful: false,
	...o,
});

let n = 0;
const item = (
	o: Partial<MigrationItem> & Pick<MigrationItem, "kind" | "name">,
): MigrationItem => ({
	id: `mgi_mock${(n++).toString().padStart(3, "0")}`,
	project: null,
	environment: null,
	status: "planned",
	support: "full",
	notes: [],
	services: [],
	targets: {},
	lastError: null,
	...o,
});

/** A small agency's Dokploy: two projects, a shared org layer, one thing that cannot move. */
function inventory(): MigrationItem[] {
	return [
		item({ kind: "s3Destination", name: "Backups (Cloudflare R2)" }),
		item({ kind: "registry", name: "GHCR acme" }),
		item({
			kind: "notificationChannel",
			name: "Ops Slack",
			support: "partial",
			notes: ["LogiStack sends no event for Docker cleanup"],
		}),
		item({ kind: "sshKey", name: "deploy" }),
		item({ kind: "gitProvider", name: "Acme GitHub" }),
		item({
			kind: "postgres",
			name: "shop-db",
			project: "Shop",
			environment: "production",
			services: [
				svc({
					name: "shop-db",
					slug: "shop-db-k2l9qa",
					kind: "database",
					engine: "postgres",
					stateful: true,
				}),
			],
		}),
		item({
			kind: "redis",
			name: "cache",
			project: "Shop",
			environment: "production",
			services: [
				svc({
					name: "cache",
					slug: "shop-cache-p0x1mz",
					kind: "database",
					engine: "redis",
					stateful: true,
				}),
			],
		}),
		item({
			kind: "application",
			name: "storefront",
			project: "Shop",
			environment: "production",
			services: [
				svc({
					name: "storefront",
					slug: "shop-storefront-a8e3rt",
					kind: "application",
					domains: ["shop.acme.dev", "www.shop.acme.dev"],
				}),
			],
		}),
		item({
			kind: "application",
			name: "api",
			project: "Shop",
			environment: "production",
			support: "partial",
			notes: [
				"built with Railpack instead of nixpacks",
				"2 redirect rule(s) are not carried over",
			],
			services: [
				svc({
					name: "api",
					slug: "shop-api-f4c7wd",
					kind: "application",
					domains: ["api.shop.acme.dev"],
				}),
			],
		}),
		item({
			kind: "application",
			name: "storefront",
			project: "Shop",
			environment: "staging",
			services: [
				svc({
					name: "storefront",
					slug: "shop-storefront-s9b2kq",
					kind: "application",
					domains: ["staging.shop.acme.dev"],
					running: false,
				}),
			],
		}),
		item({
			kind: "compose",
			name: "blog",
			project: "Blog",
			environment: "production",
			support: "partial",
			notes: ["ghost: healthcheck interval rounded to whole seconds"],
			services: [
				svc({
					name: "db",
					slug: "db",
					kind: "application",
					stateful: true,
				}),
				svc({
					name: "ghost",
					slug: "ghost",
					kind: "application",
					domains: ["blog.acme.dev"],
					stateful: true,
				}),
			],
		}),
		item({
			kind: "postgres",
			name: "vectors",
			project: "Blog",
			environment: "production",
			status: "skipped",
			support: "unsupported",
			notes: [
				"custom image pgvector/pgvector:pg16; LogiStack runs the official postgres image",
			],
		}),
	];
}

let migration: Migration | null = null;
const listeners = new Set<(itemId: string) => void>();
const emit = (itemId: string) => {
	for (const fn of listeners) fn(itemId);
};

const find = (id: string) => {
	const i = migration?.items.find((x) => x.id === id);
	if (!i) throw new ApiError(404, "migration item not found", "not_found");
	return i;
};

/** Moves an item after a delay, as the worker would, and tells the listeners. */
function settle(i: MigrationItem, ms: number, apply: () => void) {
	setTimeout(() => {
		apply();
		emit(i.id);
	}, ms);
}

export const mockMigrations: MigrationsApi = {
	source: () =>
		delay<MigrationSource>({
			source: "dokploy",
			migrationId: migration?.id ?? null,
		}),
	create: async () => {
		migration = {
			id: "mig_mock0001",
			source: "dokploy",
			status: "planned",
			createdAt: new Date().toISOString(),
			items: inventory(),
			proxy: {
				status: "not_started",
				at: null,
				error: null,
				certificates: null,
				probes: [],
			},
		};
		return delay(migration, 1200);
	},
	get: (id) => {
		if (!migration || migration.id !== id)
			throw new ApiError(404, "migration not found", "not_found");
		return delay(migration);
	},
	importAll: (id) => {
		const mig = migration;
		if (!mig || mig.id !== id)
			throw new ApiError(404, "migration not found", "not_found");
		mig.status = "importing";
		const todo = mig.items.filter(
			(i) => i.status === "planned" || i.status === "failed",
		);
		for (const [k, i] of todo.entries())
			settle(i, 500 + k * 450, () => {
				i.status = "imported";
				i.lastError = null;
				i.targets = Object.fromEntries(
					i.services.map((s) => [s.slug, `svc_${s.slug}`]),
				);
				if (k === todo.length - 1) mig.status = "imported";
			});
		if (!todo.length) mig.status = "imported";
		return delay(mig);
	},
	switchProxy: (id) => {
		const mig = migration;
		if (!mig || mig.id !== id)
			throw new ApiError(404, "migration not found", "not_found");
		const hosts = mig.items
			.filter((i) => i.status === "cut_over")
			.flatMap((i) => i.services.flatMap((s) => s.domains));
		setTimeout(() => {
			mig.proxy = {
				status: "switched",
				at: new Date().toISOString(),
				error: null,
				certificates: {
					imported: hosts.filter((h) => !h.startsWith("www.")),
					skipped: hosts
						.filter((h) => h.startsWith("www."))
						.map((hostname) => ({
							hostname,
							reason: "covered only by a multi-name certificate",
						})),
					error: null,
				},
				probes: hosts.map((hostname) => ({
					hostname,
					ok: true,
					detail: "HTTP 200",
				})),
			};
			emit("");
		}, 3500);
		return delay(mig);
	},
	item: (id, action: ItemAction) => {
		const i = find(id);
		const transitions: Record<ItemAction, () => void> = {
			skip: () => {
				i.status = "skipped";
			},
			unskip: () => {
				if (i.support === "unsupported")
					throw new ApiError(
						409,
						"an unsupported item cannot be planned",
						"conflict",
					);
				i.status = "planned";
			},
			cutover: () =>
				settle(i, 1800 + i.services.length * 600, () => {
					i.status = "cut_over";
					i.lastError = null;
				}),
			rollback: () =>
				settle(i, 1500, () => {
					i.status = "rolled_back";
				}),
		};
		transitions[action]();
		return delay(i);
	},
	live: (_id, fn) => {
		listeners.add(fn);
		return () => {
			listeners.delete(fn);
		};
	},
};
