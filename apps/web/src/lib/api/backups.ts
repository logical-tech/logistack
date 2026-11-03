import {
	backupRunChannel,
	type LiveMessage,
	scheduleRunChannel,
} from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { useEffect, useState } from "react";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";
import { subscribe } from "./live";

type Api = typeof client.api;
type Ok<F, S extends 200 | 201 | 202 = 200> = InferResponseType<F, S>;
type Body<F> = InferRequestType<F> extends { json: infer J } ? J : never;
type S3Api = Api["s3-destinations"];
type PolicyApi = Api["backup-policies"][":id"];
type ScheduleApi = Api["schedules"];

export type S3Destination = Ok<S3Api["$get"]>[number];
export type S3Connection = Body<S3Api["test"]["$post"]>;
export type S3Check = Ok<S3Api["test"]["$post"]>;
export type ServiceBackups = Ok<Api["services"][":id"]["backups"]["$get"]>;
export type BackupPolicy = ServiceBackups["policies"][number];
export type BackupRun = ServiceBackups["runs"][number];
export type BackupVolume = ServiceBackups["volumes"][number];
export type PolicyInput = Body<
	Api["services"][":id"]["backup-policies"]["$post"]
>;
export type PolicyPatch = Body<PolicyApi["$patch"]>;
export type RestoreInput = Body<Api["backup-runs"][":id"]["restore"]["$post"]>;
export type RestoreResult = Ok<
	Api["backup-runs"][":id"]["restore"]["$post"],
	202
>;
export type Schedule = Ok<ScheduleApi["$get"]>[number];
export type ScheduleDetail = Ok<ScheduleApi[":id"]["$get"]>;
export type ScheduleRun = ScheduleDetail["runs"][number];
export type ScheduleRunDetail = Ok<Api["schedule-runs"][":id"]["$get"]>;
export type ScheduleInput = Body<ScheduleApi["$post"]>;
export type SchedulePatch = Body<ScheduleApi[":id"]["$patch"]>;
export type ScheduleTarget = Schedule["target"];
export type RunStatus = BackupRun["status"];

export type BackupProgress = Extract<LiveMessage, { kind: "progress" }>;
export type RunOutput = Extract<LiveMessage, { kind: "output" }>;

export type BackupsApi = {
	s3: {
		list(): Promise<S3Destination[]>;
		test(input: S3Connection): Promise<S3Check>;
		create(input: S3Connection & { name: string }): Promise<{ id: string }>;
		remove(id: string): Promise<void>;
	};
	backups: {
		forService(serviceId: string): Promise<ServiceBackups>;
		createPolicy(serviceId: string, input: PolicyInput): Promise<BackupPolicy>;
		updatePolicy(id: string, patch: PolicyPatch): Promise<BackupPolicy>;
		removePolicy(id: string): Promise<void>;
		run(policyId: string, kind: "backup" | "verify"): Promise<BackupRun>;
		getRun(id: string): Promise<BackupRun>;
		restore(runId: string, input: RestoreInput): Promise<RestoreResult>;
	};
	schedules: {
		list(): Promise<Schedule[]>;
		get(id: string): Promise<ScheduleDetail>;
		create(input: ScheduleInput): Promise<Schedule>;
		update(id: string, patch: SchedulePatch): Promise<Schedule>;
		remove(id: string): Promise<void>;
		run(id: string): Promise<ScheduleRun>;
		getRun(id: string): Promise<ScheduleRunDetail>;
	};
	/** Live `data` frames for a /ws channel; the mock simulates them. */
	live(channel: string, fn: (data: LiveMessage) => void): () => void;
};

/** 204 responses carry no body; failures still go through `ok` for the server's error shape. */
async function done(pending: Promise<{ ok: boolean }>) {
	const res = await pending;
	if (!res.ok) await ok(Promise.resolve(res as never));
}

const param = (id: string) => ({ param: { id } });
const a = client.api;

const http: BackupsApi = {
	s3: {
		list: () => ok(a["s3-destinations"].$get()),
		test: (json) => ok(a["s3-destinations"].test.$post({ json })),
		create: (json) => ok(a["s3-destinations"].$post({ json })),
		remove: (id) => done(a["s3-destinations"][":id"].$delete(param(id))),
	},
	backups: {
		forService: (id) => ok(a.services[":id"].backups.$get(param(id))),
		createPolicy: (id, json) =>
			ok(a.services[":id"]["backup-policies"].$post({ ...param(id), json })),
		updatePolicy: (id, json) =>
			ok(a["backup-policies"][":id"].$patch({ ...param(id), json })),
		removePolicy: (id) => done(a["backup-policies"][":id"].$delete(param(id))),
		run: (id, kind) =>
			ok(
				a["backup-policies"][":id"].run.$post({ ...param(id), json: { kind } }),
			),
		getRun: (id) => ok(a["backup-runs"][":id"].$get(param(id))),
		restore: (id, json) =>
			ok(a["backup-runs"][":id"].restore.$post({ ...param(id), json })),
	},
	schedules: {
		list: () => ok(a.schedules.$get()),
		get: (id) => ok(a.schedules[":id"].$get(param(id))),
		create: (json) => ok(a.schedules.$post({ json })),
		update: (id, json) => ok(a.schedules[":id"].$patch({ ...param(id), json })),
		remove: (id) => done(a.schedules[":id"].$delete(param(id))),
		run: (id) => ok(a.schedules[":id"].run.$post(param(id))),
		getRun: (id) => ok(a["schedule-runs"][":id"].$get(param(id))),
	},
	live: subscribe,
};

export const backupsApi: BackupsApi = isMock
	? (await import("./mock/backups")).mockBackups
	: http;

export const s3DestinationsQuery = queryOptions({
	queryKey: ["s3-destinations"],
	queryFn: () => backupsApi.s3.list(),
});

export const serviceBackupsQuery = (serviceId: string) =>
	queryOptions({
		queryKey: ["backups", serviceId],
		queryFn: () => backupsApi.backups.forService(serviceId),
		// A run in flight finishes on its own; keep the panel honest without frames.
		refetchInterval: (q) =>
			q.state.data?.runs.some((r) => r.status === "running") ? 2000 : 30_000,
	});

export const schedulesQuery = queryOptions({
	queryKey: ["schedules"],
	queryFn: () => backupsApi.schedules.list(),
	refetchInterval: (q) =>
		q.state.data?.some((s) => s.lastRun?.status === "running") ? 2000 : 30_000,
});

export const scheduleQuery = (id: string) =>
	queryOptions({
		queryKey: ["schedules", id],
		queryFn: () => backupsApi.schedules.get(id),
		refetchInterval: (q) =>
			q.state.data?.runs.some((r) => r.status === "running") ? 2000 : 30_000,
	});

const settled = (s: RunStatus | undefined) =>
	s !== undefined && s !== "running";

export const backupRunQuery = (id: string) =>
	queryOptions({
		queryKey: ["backup-runs", id],
		queryFn: () => backupsApi.backups.getRun(id),
		refetchInterval: (q) => (settled(q.state.data?.status) ? false : 2000),
	});

export const scheduleRunQuery = (id: string) =>
	queryOptions({
		queryKey: ["schedule-runs", id],
		queryFn: () => backupsApi.schedules.getRun(id),
		refetchInterval: (q) => (settled(q.state.data?.status) ? false : 2000),
	});

/** A mutation that refreshes the given lists once it settles. */
function useInvalidating<A, R>(
	fn: (args: A) => Promise<R>,
	...keys: string[][]
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () =>
			Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }))),
	});
}

export const useCreateS3Destination = () =>
	useInvalidating(backupsApi.s3.create, ["s3-destinations"]);
export const useDeleteS3Destination = () =>
	useInvalidating(backupsApi.s3.remove, ["s3-destinations"]);

export const useCreatePolicy = () =>
	useInvalidating(
		({ serviceId, ...input }: PolicyInput & { serviceId: string }) =>
			backupsApi.backups.createPolicy(serviceId, input),
		["backups"],
		["s3-destinations"],
	);
export const useUpdatePolicy = () =>
	useInvalidating(
		({ id, ...patch }: PolicyPatch & { id: string }) =>
			backupsApi.backups.updatePolicy(id, patch),
		["backups"],
	);
export const useDeletePolicy = () =>
	useInvalidating(
		backupsApi.backups.removePolicy,
		["backups"],
		["s3-destinations"],
	);
export const useRunPolicy = () =>
	useInvalidating(
		({ id, kind }: { id: string; kind: "backup" | "verify" }) =>
			backupsApi.backups.run(id, kind),
		["backups"],
	);
export const useRestore = () =>
	useInvalidating(
		({ runId, ...input }: RestoreInput & { runId: string }) =>
			backupsApi.backups.restore(runId, input),
		["backups"],
		["projects"],
	);

export const useCreateSchedule = () =>
	useInvalidating(backupsApi.schedules.create, ["schedules"]);
export const useUpdateSchedule = () =>
	useInvalidating(
		({ id, ...patch }: SchedulePatch & { id: string }) =>
			backupsApi.schedules.update(id, patch),
		["schedules"],
	);
export const useDeleteSchedule = () =>
	useInvalidating(backupsApi.schedules.remove, ["schedules"]);
export const useRunSchedule = () =>
	useInvalidating(backupsApi.schedules.run, ["schedules"]);

/** A backup, verify or restore run: polled every 2 s until it settles, with live progress frames. */
export function useBackupRun(id: string | undefined) {
	const qc = useQueryClient();
	const query = useQuery({ ...backupRunQuery(id ?? ""), enabled: !!id });
	const [progress, setProgress] = useState<BackupProgress | null>(null);
	const running = !settled(query.data?.status);
	useEffect(() => {
		setProgress(null);
		if (!id || !running) return;
		return backupsApi.live(backupRunChannel(id), (msg) => {
			if (msg.kind !== "progress") return;
			setProgress(msg);
			if (msg.done) qc.invalidateQueries({ queryKey: ["backup-runs", id] });
		});
	}, [id, running, qc]);
	return { run: query.data, progress, error: query.error };
}

/** A schedule run's stored output, plus whatever streamed live while it ran. */
export function useScheduleRun(id: string | undefined) {
	const query = useQuery({ ...scheduleRunQuery(id ?? ""), enabled: !!id });
	const [live, setLive] = useState("");
	const running = !settled(query.data?.status);
	useEffect(() => {
		setLive("");
		if (!id || !running) return;
		return backupsApi.live(scheduleRunChannel(id), (msg) => {
			if (msg.kind === "output") setLive((s) => s + msg.data);
		});
	}, [id, running]);
	return { run: query.data, live, error: query.error };
}
