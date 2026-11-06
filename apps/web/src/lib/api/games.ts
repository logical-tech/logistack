/*
 * Game and voice servers: live status, console, hostnames and credentials of one game service.
 * Wire types come from the server's routes; `mock/games.ts` fills the same slice for VITE_API_MOCK=1.
 */
import type { GameKind } from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

type S = (typeof client.api.services)[":id"]["game"];
type Ok<F, St extends 200 | 201 = 200> = InferResponseType<F, St>;
type Body<F> = InferRequestType<F> extends { json: infer J } ? J : never;

export type GameServer = Ok<S["$get"]>;
export type GameEndpoint = GameServer["endpoints"][number];
export type GameCredentials = Ok<S["credentials"]["$get"]>;
export type GameEndpointInput = Body<S["endpoints"]["$post"]>;

export type GamesApi = {
	get(id: string): Promise<GameServer>;
	/** 403 without read:secrets on the service. */
	credentials(id: string): Promise<GameCredentials>;
	command(id: string, command: string): Promise<{ output: string }>;
	adminKey(id: string): Promise<{ key: string }>;
	suggestPort(
		game: GameKind,
		nodeId: string | undefined,
		geyser: boolean,
	): Promise<{ port: number | null }>;
	minecraftVersions(): Promise<{ versions: string[] }>;
	endpoints: {
		create(id: string, input: GameEndpointInput): Promise<GameEndpoint>;
		sync(endpointId: string): Promise<GameEndpoint>;
		remove(endpointId: string): Promise<void>;
	};
};

const g = client.api.services[":id"].game;
const e = client.api["game-endpoints"][":id"];
const p = (id: string) => ({ param: { id } });

const http: GamesApi = {
	get: (id) => ok(g.$get(p(id))),
	credentials: (id) => ok(g.credentials.$get(p(id))),
	command: (id, command) =>
		ok(g.command.$post({ ...p(id), json: { command } })),
	adminKey: (id) => ok(g["admin-key"].$post(p(id))),
	suggestPort: (game, nodeId, geyser) =>
		ok(
			client.api.games.port.$get({
				query: {
					game,
					...(nodeId ? { nodeId } : {}),
					...(geyser ? { geyser: "true" as const } : {}),
				},
			}),
		),
	minecraftVersions: () => ok(client.api.games.minecraft.versions.$get()),
	endpoints: {
		create: (id, json) => ok(g.endpoints.$post({ ...p(id), json })),
		sync: (id) => ok(e.sync.$post(p(id))),
		remove: (id) => done(e.$delete(p(id))),
	},
};

export const gamesApi: GamesApi = isMock
	? (await import("./mock/games")).mockGames
	: http;

const key = (id: string) => ["games", id];

export const gameQuery = (id: string) =>
	queryOptions({
		queryKey: key(id),
		queryFn: () => gamesApi.get(id),
		// The probe is cheap and players come and go.
		refetchInterval: 10_000,
	});

export const gameCredentialsQuery = (id: string) =>
	queryOptions({
		queryKey: [...key(id), "credentials"],
		queryFn: () => gamesApi.credentials(id),
		retry: false,
		staleTime: 60_000,
	});

export const gamePortQuery = (
	game: GameKind,
	nodeId: string | undefined,
	geyser: boolean,
) =>
	queryOptions({
		queryKey: ["games", "port", game, nodeId ?? "", geyser],
		queryFn: () => gamesApi.suggestPort(game, nodeId, geyser),
	});

export const minecraftVersionsQuery = queryOptions({
	queryKey: ["games", "minecraft", "versions"],
	queryFn: () => gamesApi.minecraftVersions(),
	staleTime: 3_600_000,
	retry: false,
});

/** A mutation that refreshes the game view of `id` when it settles. */
export function useGameMutation<A, R>(id: string, fn: (a: A) => Promise<R>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () => qc.invalidateQueries({ queryKey: key(id) }),
	});
}
