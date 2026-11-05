import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { useEffect, useState } from "react";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";
import { subscribeEvents } from "./live";

type Api = typeof client.api;

export type MigrationSource = InferResponseType<
	Api["migrations"]["source"]["$get"],
	200
>;
export type Migration = InferResponseType<
	Api["migrations"][":id"]["$get"],
	200
>;
export type MigrationItem = Migration["items"][number];
export type ItemAction = "cutover" | "rollback" | "skip" | "unskip";

export type MigrationsApi = {
	source(): Promise<MigrationSource>;
	/** Reads Dokploy and plans; nothing changes on either side. */
	create(): Promise<Migration>;
	get(id: string): Promise<Migration>;
	importAll(id: string): Promise<Migration>;
	switchProxy(id: string): Promise<Migration>;
	/** Archives Dokploy on the server, then removes it. */
	decommission(id: string): Promise<Migration>;
	item(id: string, action: ItemAction): Promise<MigrationItem>;
	/** Calls `fn` on every item change of the migration; the mock simulates them. */
	live(id: string, fn: (itemId: string) => void): () => void;
};

const m = client.api.migrations;
const items = client.api["migration-items"][":id"];
const http: MigrationsApi = {
	source: () => ok(m.source.$get()),
	create: () => ok(m.$post()),
	get: (id) => ok(m[":id"].$get({ param: { id } })),
	importAll: (id) => ok(m[":id"].import.$post({ param: { id } })),
	switchProxy: (id) => ok(m[":id"]["proxy-switch"].$post({ param: { id } })),
	decommission: (id) => ok(m[":id"].decommission.$post({ param: { id } })),
	item: (id, action) => ok(items[action].$post({ param: { id } })),
	live: (id, fn) =>
		subscribeEvents(`migration:${id}`, (e) => {
			if (e.type === "migration.item_changed")
				fn(String(e.payload.itemId ?? ""));
		}),
};

export const migrationsApi: MigrationsApi = isMock
	? (await import("./mock/migrations")).mockMigrations
	: http;

export const migrationSourceQuery = queryOptions({
	queryKey: ["migrations", "source"],
	queryFn: () => migrationsApi.source(),
	staleTime: 60_000,
});

const migrationKey = (id: string) => ["migrations", id] as const;

/**
 * A migration, kept fresh by its events. `moving` holds the items the user just set in motion
 * until their next event lands, so a row shows progress before the server has settled it.
 */
export function useMigration(id: string | null | undefined) {
	const qc = useQueryClient();
	const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
	/** A job that publishes no item event (proxy switch, decommission) the page waits on. */
	const [awaiting, setAwaiting] = useState<"proxy" | "decommission" | null>(
		null,
	);
	const query = useQuery({
		queryKey: migrationKey(id ?? ""),
		queryFn: () => migrationsApi.get(id as string),
		enabled: Boolean(id),
		// Events carry item changes; polling covers a dropped socket and the jobs without events.
		refetchInterval: (q) => {
			const d = q.state.data;
			const waiting =
				(awaiting === "proxy" && d?.proxy.status === "not_started") ||
				(awaiting === "decommission" &&
					d?.decommission.status === "not_started");
			return moving.size || d?.status === "importing" || waiting
				? 3_000
				: false;
		},
	});
	useEffect(() => {
		if (!id) return;
		return migrationsApi.live(id, (itemId) => {
			setMoving((s) => {
				if (!s.has(itemId)) return s;
				const next = new Set(s);
				next.delete(itemId);
				return next;
			});
			void qc.invalidateQueries({ queryKey: migrationKey(id) });
		});
	}, [id, qc]);
	const mark = (itemIds: string[]) =>
		setMoving((s) => new Set([...s, ...itemIds]));
	const settle = (itemId: string) =>
		setMoving((s) => {
			const next = new Set(s);
			next.delete(itemId);
			return next;
		});
	return { ...query, moving, mark, settle, await: setAwaiting };
}

export function useCreateMigration() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => migrationsApi.create(),
		onSuccess: (mig) => {
			qc.setQueryData(migrationKey(mig.id), mig);
			qc.setQueryData(migrationSourceQuery.queryKey, (s) =>
				s ? { ...s, migrationId: mig.id } : s,
			);
		},
	});
}

export function useMigrationAction(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (a: { kind: "import" | "proxy" | "decommission" }) =>
			a.kind === "import"
				? migrationsApi.importAll(id)
				: a.kind === "proxy"
					? migrationsApi.switchProxy(id)
					: migrationsApi.decommission(id),
		onSuccess: (mig) => qc.setQueryData(migrationKey(id), mig),
	});
}

export function useItemAction(migrationId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ itemId, action }: { itemId: string; action: ItemAction }) =>
			migrationsApi.item(itemId, action),
		onSuccess: (item) =>
			qc.setQueryData(
				migrationKey(migrationId),
				(mig: Migration | undefined) =>
					mig
						? {
								...mig,
								items: mig.items.map((i) => (i.id === item.id ? item : i)),
							}
						: mig,
			),
	});
}

/** Services first by what others need: databases, then apps, then composes; org resources apart. */
export const isOrgItem = (i: MigrationItem) => i.project === null;
const ORDER = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"application",
	"compose",
];
export const cutoverOrder = (items: MigrationItem[]) =>
	items
		.filter((i) => !isOrgItem(i))
		.toSorted((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

/** GitHub providers move their webhook at cutover, which needs Caddy on 443: after the switch. */
export const isGitHubProvider = (i: MigrationItem) => i.kind === "gitProvider";
