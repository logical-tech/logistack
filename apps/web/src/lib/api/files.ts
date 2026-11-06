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
const cf = s["container-files"];
export type ContainerListing = Ok<(typeof cf)["$get"]>;
export type ContainerEntry = NonNullable<ContainerListing["entries"]>[number];
export type ContainerFileContent = Ok<(typeof cf)["content"]["$get"]>;

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
	/** A running replica's filesystem; an empty `taskId` means the first replica. */
	container: {
		list(id: string, taskId: string, path: string): Promise<ContainerListing>;
		read(
			id: string,
			taskId: string,
			path: string,
		): Promise<ContainerFileContent>;
		/** `path` is the file's absolute path in the container. */
		upload: typeof uploadToVolume;
	};
};

const containerQuery = (taskId: string, path: string) => ({
	path,
	...(taskId ? { taskId } : {}),
});

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
	container: {
		list: (id, taskId, path) =>
			ok(cf.$get({ param: { id }, query: containerQuery(taskId, path) })),
		read: (id, taskId, path) =>
			ok(
				cf.content.$get({ param: { id }, query: containerQuery(taskId, path) }),
			),
		upload: (id, taskId, path, file, onProgress) =>
			put(
				`/api/services/${encodeURIComponent(id)}/container-files/upload?${new URLSearchParams(containerQuery(taskId, path))}`,
				file,
				onProgress,
			),
	},
};

/** Where the browser downloads a container file from (cookie-authenticated). */
export const containerDownloadUrl = (
	id: string,
	taskId: string,
	path: string,
) =>
	`/api/services/${encodeURIComponent(id)}/container-files/download?${new URLSearchParams(containerQuery(taskId, path))}`;

export const containerKey = (id: string, taskId: string) =>
	["files", id, "container", taskId] as const;

export const containerListQuery = (id: string, taskId: string, path: string) =>
	queryOptions({
		queryKey: [...containerKey(id, taskId), path],
		queryFn: () => filesApi.container.list(id, taskId, path),
		retry: false,
	});

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
	return put(
		`/api/services/${encodeURIComponent(id)}/volumes/${encodeURIComponent(mountId)}/upload?path=${encodeURIComponent(key)}`,
		file,
		onProgress,
	);
}

/** A raw-body PUT with upload progress, which fetch cannot report. */
function put(
	url: string,
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
	xhr.open("PUT", url);
	xhr.withCredentials = true;
	xhr.setRequestHeader("Content-Type", "application/octet-stream");
	xhr.send(file);
	return { done: finished, abort: () => xhr.abort() };
}
