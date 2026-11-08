/*
 * Public access, port forwards and major-version upgrades of a database service
 * (docs/plans/database-ops.md). `mock/database-ops.ts` fills the same slice for VITE_API_MOCK=1.
 */
import type {
	DatabaseAccessList,
	DatabaseAccessView,
	DatabaseUpgradeView,
	PortForwardInput,
	PublicAccessInput,
} from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

export type DatabaseOpsApi = {
	access(id: string): Promise<DatabaseAccessList>;
	/** 403 without admin, 409 when the port is taken on the database's node. */
	setPublic(id: string, input: PublicAccessInput): Promise<DatabaseAccessView>;
	closePublic(id: string): Promise<void>;
	openForward(id: string, input: PortForwardInput): Promise<DatabaseAccessView>;
	closeForward(id: string, accessId: string): Promise<void>;
	upgrades(id: string): Promise<DatabaseUpgradeView[]>;
	/** 400 when the version is not later, 409 while another upgrade runs. */
	startUpgrade(id: string, version: string): Promise<DatabaseUpgradeView>;
};

const d = client.api.databases[":id"];

const http: DatabaseOpsApi = {
	access: (id) =>
		ok(d.access.$get({ param: { id } })) as Promise<DatabaseAccessList>,
	setPublic: (id, json) =>
		ok(
			d.access.public.$put({ param: { id }, json }),
		) as Promise<DatabaseAccessView>,
	closePublic: (id) => done(d.access.public.$delete({ param: { id } })),
	openForward: (id, json) =>
		ok(
			d.forwards.$post({ param: { id }, json }),
		) as Promise<DatabaseAccessView>,
	closeForward: (id, accessId) =>
		done(d.forwards[":accessId"].$delete({ param: { id, accessId } })),
	upgrades: (id) =>
		ok(d.upgrades.$get({ param: { id } })) as Promise<DatabaseUpgradeView[]>,
	startUpgrade: (id, version) =>
		ok(
			d.upgrades.$post({ param: { id }, json: { version } }),
		) as Promise<DatabaseUpgradeView>,
};

export const databaseOpsApi: DatabaseOpsApi = isMock
	? (await import("./mock/database-ops")).mockDatabaseOps
	: http;

const key = (id: string) => ["database-ops", id] as const;

/** Polls while something is converging: a gateway starting, a certificate pending, an upgrade running. */
export const accessQuery = (id: string) =>
	queryOptions({
		queryKey: [...key(id), "access"],
		queryFn: () => databaseOpsApi.access(id),
		refetchInterval: (q) =>
			q.state.data?.access.some((a) => a.status !== "active") ? 3000 : 30_000,
	});

export const upgradesQuery = (id: string) =>
	queryOptions({
		queryKey: [...key(id), "upgrades"],
		queryFn: () => databaseOpsApi.upgrades(id),
		refetchInterval: (q) =>
			q.state.data?.some((u) => u.status === "running") ? 2000 : false,
	});

export function useDatabaseOps(id: string) {
	const qc = useQueryClient();
	const refresh = () => qc.invalidateQueries({ queryKey: key(id) });
	return {
		setPublic: useMutation({
			mutationFn: (input: PublicAccessInput) =>
				databaseOpsApi.setPublic(id, input),
			onSuccess: refresh,
		}),
		closePublic: useMutation({
			mutationFn: () => databaseOpsApi.closePublic(id),
			onSuccess: refresh,
		}),
		openForward: useMutation({
			mutationFn: (input: PortForwardInput) =>
				databaseOpsApi.openForward(id, input),
			onSuccess: refresh,
		}),
		closeForward: useMutation({
			mutationFn: (accessId: string) =>
				databaseOpsApi.closeForward(id, accessId),
			onSuccess: refresh,
		}),
		startUpgrade: useMutation({
			mutationFn: (version: string) => databaseOpsApi.startUpgrade(id, version),
			onSuccess: refresh,
		}),
	};
}
