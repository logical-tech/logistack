/*
 * Object storage: the cross-project list, one service's buckets, objects, scoped keys and
 * connection details. Wire types come from the server's routes; `mock/storage.ts` fills the
 * same slice for VITE_API_MOCK=1.
 */
import {
	type InfiniteData,
	infiniteQueryOptions,
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

type Api = typeof client.api.storage;
type S = Api[":id"];
type B = S["buckets"][":bucket"];
type Ok<F, St extends 200 | 201 = 200> = InferResponseType<F, St>;
type Body<F> = InferRequestType<F> extends { json: infer J } ? J : never;

export type StorageListItem = Ok<Api["$get"]>[number];
export type StorageConnection = Ok<S["connection"]["$get"]>;
export type StorageCapabilities = StorageConnection["capabilities"];
export type StorageCredentials = Ok<S["credentials"]["$get"]>;
export type Bucket = Ok<S["buckets"]["$get"]>[number];
export type BucketPatch = Body<B["$patch"]>;
export type ObjectPage = Ok<B["objects"]["$get"]>;
export type ObjectEntry = ObjectPage["objects"][number];
export type ObjectMeta = Ok<B["object"]["$get"]>;
export type ShareLink = Ok<B["share"]["$post"]>;
export type AccessKey = Ok<S["keys"]["$get"]>[number];
export type AccessKeyInput = Body<S["keys"]["$post"]>;
export type CreatedAccessKey = Ok<S["keys"]["$post"], 201>;

export type UploadHandle = {
	done: Promise<void>;
	abort: () => void;
};

export type StorageApi = {
	list(): Promise<StorageListItem[]>;
	connection(id: string): Promise<StorageConnection>;
	/** 403 without read:secrets on the service. */
	credentials(id: string): Promise<StorageCredentials>;
	buckets: {
		list(id: string): Promise<Bucket[]>;
		create(id: string, name: string): Promise<void>;
		update(id: string, bucket: string, patch: BucketPatch): Promise<void>;
		/** Deletes every object first; the server checks `confirm` equals the name. */
		remove(id: string, bucket: string): Promise<void>;
	};
	objects: {
		list(
			id: string,
			bucket: string,
			query: { prefix: string; cursor?: string },
		): Promise<ObjectPage>;
		head(id: string, bucket: string, key: string): Promise<ObjectMeta>;
		/** The bytes, for previews; downloads navigate to `downloadUrl`. */
		fetch(id: string, bucket: string, key: string): Promise<Blob>;
		downloadUrl(id: string, bucket: string, key: string): string;
		/** Streams through the API (engines stay private); reports progress per file. */
		upload(
			id: string,
			bucket: string,
			key: string,
			file: File,
			onProgress: (loaded: number) => void,
		): UploadHandle;
		remove(id: string, bucket: string, keys: string[]): Promise<void>;
		/** `key` ends in `/`. */
		createFolder(id: string, bucket: string, key: string): Promise<void>;
		move(id: string, bucket: string, from: string, to: string): Promise<void>;
		share(
			id: string,
			bucket: string,
			key: string,
			expiresIn: number,
		): Promise<ShareLink>;
	};
	keys: {
		list(id: string): Promise<AccessKey[]>;
		create(id: string, input: AccessKeyInput): Promise<CreatedAccessKey>;
		revoke(id: string, keyId: string): Promise<void>;
	};
	/** Needs organization admin; 403 otherwise. */
	backupDestination(
		id: string,
		input: { bucket?: string },
	): Promise<{ id: string }>;
};

const s = client.api.storage[":id"];
const b = s.buckets[":bucket"];
const p = (id: string) => ({ param: { id } });
const pb = (id: string, bucket: string) => ({ param: { id, bucket } });
const objectPath = (id: string, bucket: string, verb: string, key: string) =>
	`/api/storage/${encodeURIComponent(id)}/buckets/${encodeURIComponent(bucket)}/${verb}?key=${encodeURIComponent(key)}`;

function upload(
	id: string,
	bucket: string,
	key: string,
	file: File,
	onProgress: (loaded: number) => void,
): UploadHandle {
	const xhr = new XMLHttpRequest();
	const finished = new Promise<void>((resolve, reject) => {
		xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) return resolve();
			const message = (() => {
				try {
					return (
						JSON.parse(xhr.responseText) as { error?: { message?: string } }
					).error?.message;
				} catch {
					return undefined;
				}
			})();
			reject(new Error(message ?? `Upload failed with ${xhr.status}`));
		};
		xhr.onerror = () => reject(new Error("The connection dropped."));
		xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
	});
	xhr.open("PUT", objectPath(id, bucket, "upload", key));
	xhr.withCredentials = true;
	xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
	xhr.send(file);
	return { done: finished, abort: () => xhr.abort() };
}

const http: StorageApi = {
	list: () => ok(client.api.storage.$get()),
	connection: (id) => ok(s.connection.$get(p(id))),
	credentials: (id) => ok(s.credentials.$get(p(id))),
	buckets: {
		list: (id) => ok(s.buckets.$get(p(id))),
		create: async (id, name) => {
			await ok(s.buckets.$post({ ...p(id), json: { name } }));
		},
		update: (id, bucket, json) => done(b.$patch({ ...pb(id, bucket), json })),
		remove: async (id, bucket) => {
			await ok(b.$delete({ ...pb(id, bucket), query: { confirm: bucket } }));
		},
	},
	objects: {
		list: (id, bucket, { prefix, cursor }) =>
			ok(
				b.objects.$get({
					...pb(id, bucket),
					query: { prefix, ...(cursor ? { cursor } : {}), limit: "200" },
				}),
			),
		head: (id, bucket, key) =>
			ok(b.object.$get({ ...pb(id, bucket), query: { key } })),
		fetch: async (id, bucket, key) => {
			const res = await fetch(objectPath(id, bucket, "download", key), {
				credentials: "include",
			});
			if (!res.ok) await ok(Promise.resolve(res as never));
			return res.blob();
		},
		downloadUrl: (id, bucket, key) => objectPath(id, bucket, "download", key),
		upload,
		remove: async (id, bucket, keys) => {
			await ok(b.delete.$post({ ...pb(id, bucket), json: { keys } }));
		},
		createFolder: async (id, bucket, key) => {
			await ok(b.folder.$post({ ...pb(id, bucket), json: { key } }));
		},
		move: (id, bucket, from, to) =>
			done(
				b.copy.$post({
					...pb(id, bucket),
					json: { from, to, move: true },
				}),
			),
		share: (id, bucket, key, expiresIn) =>
			ok(
				b.share.$post({
					...pb(id, bucket),
					json: { key, expiresIn },
				}),
			),
	},
	keys: {
		list: (id) => ok(s.keys.$get(p(id))),
		create: (id, json) => ok(s.keys.$post({ ...p(id), json })),
		revoke: (id, keyId) =>
			done(s.keys[":keyId"].$delete({ param: { id, keyId } })),
	},
	backupDestination: (id, json) =>
		ok(s["backup-destination"].$post({ ...p(id), json })),
};

export const storageApi: StorageApi = isMock
	? (await import("./mock/storage")).mockStorage
	: http;

// Queries

const key = (id: string) => ["storage", id];

export const storageListQuery = queryOptions({
	queryKey: ["storage"],
	queryFn: () => storageApi.list(),
	refetchInterval: 15_000,
});

export const connectionQuery = (id: string) =>
	queryOptions({
		queryKey: [...key(id), "connection"],
		queryFn: () => storageApi.connection(id),
	});

export const credentialsQuery = (id: string) =>
	queryOptions({
		queryKey: [...key(id), "credentials"],
		queryFn: () => storageApi.credentials(id),
		// A 403 is an answer (no read:secrets), not a hiccup to retry.
		retry: false,
		staleTime: 60_000,
	});

export const bucketsQuery = (id: string) =>
	queryOptions({
		queryKey: [...key(id), "buckets"],
		queryFn: () => storageApi.buckets.list(id),
	});

export const objectsQuery = (id: string, bucket: string, prefix: string) =>
	infiniteQueryOptions({
		queryKey: [...key(id), "objects", bucket, prefix],
		queryFn: ({ pageParam }) =>
			storageApi.objects.list(id, bucket, {
				prefix,
				...(pageParam ? { cursor: pageParam } : {}),
			}),
		initialPageParam: "",
		getNextPageParam: (last) => last.nextCursor ?? undefined,
	});

export type ObjectPages = InfiniteData<ObjectPage, string>;

export const objectMetaQuery = (
	id: string,
	bucket: string,
	objectKey: string,
) =>
	queryOptions({
		queryKey: [...key(id), "object", bucket, objectKey],
		queryFn: () => storageApi.objects.head(id, bucket, objectKey),
	});

export const accessKeysQuery = (id: string) =>
	queryOptions({
		queryKey: [...key(id), "keys"],
		queryFn: () => storageApi.keys.list(id),
	});

/** A storage mutation that refreshes everything shown about that service once it settles. */
export function useStorageMutation<A, R>(
	id: string,
	fn: (args: A) => Promise<R>,
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () => qc.invalidateQueries({ queryKey: key(id) }),
	});
}
