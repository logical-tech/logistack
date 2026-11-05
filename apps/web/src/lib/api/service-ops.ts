/*
 * One service's page: overview, deployments, actions, env vars, terminal tickets and log
 * streams. Wire types inferred from the server's routes, the adapter slice both
 * implementations fill, and the query hooks.
 */
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { useEffect, useState } from "react";
import { stripAnsi } from "../ansi";
import { DEPLOYMENT_STATUS } from "../status";
import { api } from ".";
import { client } from "./client";
import { done, ok } from "./http";
import { type StreamFrame, subscribeStream } from "./live";
import type { ServiceId } from "./types";

type Api = typeof client.api;
type S = Api["services"][":id"];
type Res<F, St extends 200 | 201 | 202 = 200> = InferResponseType<F, St>;
type Body<F> = InferRequestType<F> extends { json: infer J } ? J : never;

export type ServiceOverview = Res<S["overview"]["$get"]>;
export type ServiceTask = ServiceOverview["status"]["tasks"][number];
export type DeploymentRow = Res<S["deployments"]["$get"]>[number];
export type DeploymentId = DeploymentRow["id"];
export type ServiceRecord = Res<S["$patch"]>;
export type ServicePatch = Body<S["$patch"]>;
export type EffectiveEnvVar = Res<S["env-vars"]["$get"]>[number];
export type EnvScope = EffectiveEnvVar["scope"];
export type ServiceVarInput = Body<S["env-vars"]["$put"]>["variables"][number];
export type ExecInput = Body<S["exec"]["$post"]>;
export type ExecTicket = Res<S["exec"]["$post"], 201>;
export type Shell = ExecInput["shell"];

/** What a `service-logs:` subscription accepts (`LogOptions` in the server's streams.ts). */
export type LogOptions = {
	tail?: number | "all";
	since?: number;
	taskId?: string;
};
export type LogSource =
	| { kind: "deployment"; id: DeploymentId }
	| { kind: "service"; id: ServiceId; options: LogOptions };

export type ServiceOpsApi = {
	overview(id: ServiceId): Promise<ServiceOverview>;
	update(id: ServiceId, patch: ServicePatch): Promise<ServiceRecord>;
	remove(id: ServiceId): Promise<void>;
	deployments(id: ServiceId, limit: number): Promise<DeploymentRow[]>;
	deploy(id: ServiceId): Promise<DeploymentRow>;
	/** Rolling restart on the current image; 409 when the service was never healthy. */
	restart(id: ServiceId): Promise<DeploymentRow>;
	stop(id: ServiceId): Promise<ServiceRecord>;
	start(id: ServiceId): Promise<ServiceRecord>;
	rollback(id: DeploymentId): Promise<DeploymentRow>;
	cancel(id: DeploymentId): Promise<DeploymentRow>;
	envVars(id: ServiceId): Promise<EffectiveEnvVar[]>;
	/** Replaces the service-scope set; a variable without `value` keeps its stored one. */
	saveEnvVars(id: ServiceId, variables: ServiceVarInput[]): Promise<void>;
	/** A one-time ticket for `/ws/exec`; 403 without `exec`, 409 with no running replica. */
	exec(id: ServiceId, input: ExecInput): Promise<ExecTicket>;
	/** Replays, then follows. Returns the unsubscribe. */
	streamLogs(source: LogSource, onFrame: (f: StreamFrame) => void): () => void;
};

const s = () => client.api.services[":id"];
const d = () => client.api.deployments[":id"];
const id = (v: string) => ({ param: { id: v } });

export const serviceOpsHttp: ServiceOpsApi = {
	overview: (v) => ok(s().overview.$get(id(v))),
	update: (v, json) => ok(s().$patch({ ...id(v), json })),
	remove: (v) => done(s().$delete(id(v))),
	deployments: (v, limit) =>
		ok(s().deployments.$get({ ...id(v), query: { limit: String(limit) } })),
	deploy: (v) => ok(s().deploy.$post(id(v))),
	restart: (v) => ok(s().restart.$post(id(v))),
	stop: (v) => ok(s().stop.$post(id(v))),
	start: (v) => ok(s().start.$post(id(v))),
	rollback: (v) => ok(d().rollback.$post(id(v))),
	cancel: (v) => ok(d().cancel.$post(id(v))),
	envVars: (v) => ok(s()["env-vars"].$get(id(v))),
	saveEnvVars: async (v, variables) => {
		await ok(s()["env-vars"].$put({ ...id(v), json: { variables } }));
	},
	exec: (v, json) => ok(s().exec.$post({ ...id(v), json })),
	streamLogs: (source, fn) =>
		source.kind === "deployment"
			? subscribeStream(`deployment-log:${source.id}`, undefined, fn)
			: subscribeStream(`service-logs:${source.id}`, source.options, fn),
};

// Queries

export const serviceKey = (id: ServiceId) => ["service", id];

export const overviewQuery = (id: ServiceId) =>
	queryOptions({
		queryKey: [...serviceKey(id), "overview"],
		queryFn: () => api.serviceOps.overview(id),
		refetchInterval: 5_000,
	});

export const isRunning = (d: Pick<DeploymentRow, "status">) =>
	DEPLOYMENT_STATUS[d.status].live === true;

export const deploymentsQuery = (id: ServiceId) =>
	queryOptions({
		queryKey: [...serviceKey(id), "deployments"],
		queryFn: () => api.serviceOps.deployments(id, 50),
		refetchInterval: (q) => (q.state.data?.some(isRunning) ? 2_000 : 10_000),
	});

export const envVarsQuery = (id: ServiceId) =>
	queryOptions({
		queryKey: [...serviceKey(id), "env-vars"],
		queryFn: () => api.serviceOps.envVars(id),
	});

/** A mutation on one service that refreshes everything shown about it once it lands. */
export function useServiceMutation<A, R>(
	serviceId: ServiceId,
	fn: (args: A) => Promise<R>,
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () =>
			Promise.all(
				[serviceKey(serviceId), ["services"], ["projects"]].map((queryKey) =>
					qc.invalidateQueries({ queryKey }),
				),
			),
	});
}

// Log streams

export type LogLine = {
	key: number;
	/** As received, ANSI escapes included. */
	raw: string;
	/** Escapes stripped: what search and copy work on. */
	plain: string;
	at?: string;
	slot?: number | null;
	/** Which stream the line came from, when several are read together. */
	tag?: string;
};

// shortcut: the newest 20k lines stay in memory; older ones drop off the top. Page from the server if longer logs matter.
const MAX_LINES = 20_000;
// Unique across streams, so a row never inherits the measured height of an earlier one.
let lineKey = 0;
/** Docker's RFC 3339 timestamps sort as strings; lines without one keep their place. */
const byTime = (a?: LogLine, b?: LogLine) =>
	a?.at && b?.at ? a.at.localeCompare(b.at) : 0;

/**
 * Lines of one log stream, batched per animation frame. `ended` carries the server's reason
 * once it says nothing more will come. A new source, or a new `epoch`, starts over.
 */
export function useLogStream(source: LogSource | null, epoch = "") {
	return useLogStreams(source ? [{ tag: "", source }] : null, epoch);
}

/**
 * Several log streams read as one timeline, each line tagged with its stream's `tag`.
 * `ended` is set once every stream has ended, with the first reason given.
 */
export function useLogStreams(
	sources: { tag: string; source: LogSource }[] | null,
	epoch = "",
) {
	const sourceKey = sources ? JSON.stringify([sources, epoch]) : null;
	const [state, setState] = useState<{
		key: string | null;
		lines: LogLine[];
		ended: string | null;
	}>({ key: null, lines: [], ended: null });

	useEffect(() => {
		if (!sourceKey) return;
		const [srcs] = JSON.parse(sourceKey) as [
			{ tag: string; source: LogSource }[],
		];
		setState({ key: sourceKey, lines: [], ended: null });
		let pending: LogLine[] = [];
		const reasons: string[] = [];
		let frame = 0;
		const flush = () => {
			frame = 0;
			const add = pending;
			pending = [];
			const ended =
				reasons.length === srcs.length ? (reasons[0] ?? null) : null;
			setState((s) => {
				let lines = add.length ? s.lines.concat(add) : s.lines;
				// Replicas replay their tails one after another; read them as one timeline.
				const from = Math.max(s.lines.length, 1);
				if (
					lines.slice(from).some((l, i) => byTime(lines[from + i - 1], l) > 0)
				)
					lines = lines.toSorted(byTime);
				return {
					key: s.key,
					lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines,
					ended: ended ?? s.ended,
				};
			});
		};
		const stops = srcs.map(({ tag, source }) => {
			// A reconnect replays the deployment log from the start; seq drops what we have.
			let nextSeq = 0;
			return api.serviceOps.streamLogs(source, (f) => {
				if (f.type === "end") reasons.push(f.reason);
				else {
					if (f.seq !== undefined) {
						if (f.seq < nextSeq) return;
						nextSeq = f.seq + 1;
					}
					pending.push({
						key: lineKey++,
						raw: f.line,
						plain: stripAnsi(f.line),
						at: f.at || undefined,
						slot: f.slot,
						...(tag && { tag }),
					});
				}
				frame ||= requestAnimationFrame(flush);
			});
		});
		return () => {
			for (const stop of stops) stop();
			cancelAnimationFrame(frame);
		};
	}, [sourceKey]);

	return state.key === sourceKey ? state : { lines: [], ended: null };
}
