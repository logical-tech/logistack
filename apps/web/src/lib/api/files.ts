/*
 * A service's config files and named-volume contents. `mock/files.ts` fills the same slice
 * for VITE_API_MOCK=1.
 */
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";
import type { UploadHandle } from "./storage";

const s = client.api.services[":id"];
type Ok<F> = InferResponseType<F, 200>;

export type ServiceFiles = Ok<(typeof s)["files"]["$get"]>;
export type ConfigFile = ServiceFiles["files"][number];
export type VolumeListing = Ok<
	(typeof s)["volumes"][":mountId"]["files"]["$get"]
>;
export type VolumeFile = VolumeListing["files"][number];

export type FilesApi = {
	get(id: string): Promise<ServiceFiles>;
	save(
		id: string,
		mountId: string,
		content: string,
	): Promise<{ deployment: { id: string } }>;
	list(id: string, mountId: string): Promise<VolumeListing>;
	remove(id: string, mountId: string, path: string): Promise<void>;
	upload: typeof uploadToVolume;
};

const http: FilesApi = {
	get: (id) => ok(s.files.$get({ param: { id } })),
	save: (id, mountId, content) =>
		ok(s.files[":mountId"].$put({ param: { id, mountId }, json: { content } })),
	list: (id, mountId) =>
		ok(s.volumes[":mountId"].files.$get({ param: { id, mountId } })),
	remove: (id, mountId, path) =>
		done(
			s.volumes[":mountId"].files.$delete({
				param: { id, mountId },
				query: { path },
			}),
		),
	upload: (...args) => uploadToVolume(...args),
};

export const filesApi: FilesApi = isMock
	? (await import("./mock/files")).mockFiles
	: http;

export const filesQuery = (id: string) =>
	queryOptions({
		queryKey: ["files", id],
		queryFn: () => filesApi.get(id),
	});

export const volumeKey = (id: string, mountId: string) =>
	["files", id, "volume", mountId] as const;

export const volumeQuery = (id: string, mountId: string) =>
	queryOptions({
		queryKey: volumeKey(id, mountId),
		queryFn: () => filesApi.list(id, mountId),
		retry: false,
	});

/** Saves the file and queues the deployment that rolls it out. */
export function useSaveConfig(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mountId, content }: { mountId: string; content: string }) =>
			filesApi.save(id, mountId, content),
		onSuccess: () =>
			Promise.all([
				qc.invalidateQueries({ queryKey: ["files", id] }),
				qc.invalidateQueries({ queryKey: ["service", id] }),
			]),
	});
}

export function useDeleteVolumeFile(id: string, mountId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (path: string) => filesApi.remove(id, mountId, path),
		onSettled: () => qc.invalidateQueries({ queryKey: volumeKey(id, mountId) }),
	});
}

/** One file into a volume, `key` relative to its root; same shape as an object upload. */
export function uploadToVolume(
	id: string,
	mountId: string,
	key: string,
	file: File,
	onProgress: (loaded: number) => void,
): UploadHandle {
	const xhr = new XMLHttpRequest();
	const finished = new Promise<void>((resolve, reject) => {
		xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) return resolve();
			let message: string | undefined;
			try {
				message = (
					JSON.parse(xhr.responseText) as { error?: { message?: string } }
				).error?.message;
			} catch {}
			reject(new Error(message ?? `Upload failed with ${xhr.status}`));
		};
		xhr.onerror = () => reject(new Error("The connection dropped."));
		xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
	});
	xhr.open(
		"PUT",
		`/api/services/${encodeURIComponent(id)}/volumes/${encodeURIComponent(mountId)}/upload?path=${encodeURIComponent(key)}`,
	);
	xhr.withCredentials = true;
	xhr.setRequestHeader("Content-Type", "application/octet-stream");
	xhr.send(file);
	return { done: finished, abort: () => xhr.abort() };
}
