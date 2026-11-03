import { z } from "zod";

export const storageEngines = [
	"minio",
	"rustfs",
	"garage",
	"seaweedfs",
] as const;
export const StorageEngine = z.enum(storageEngines);
export type StorageEngine = z.infer<typeof StorageEngine>;

/** S3 bucket naming rules (the strict subset every engine accepts). */
export const BucketName = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
		"3 to 63 lowercase letters, digits, dots and dashes",
	)
	.refine((b) => !b.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(b), {
		message: "no consecutive dots and not an IP address",
	});

/** An object key; S3 allows up to 1024 bytes of UTF-8. */
export const ObjectKey = z
	.string()
	.min(1)
	.refine((k) => new TextEncoder().encode(k).length <= 1024, {
		message: "at most 1024 bytes",
	});

/** What a scoped access key may do on its buckets. */
export const storageKeyAccess = ["read", "readwrite"] as const;
export const StorageKeyAccess = z.enum(storageKeyAccess);
export type StorageKeyAccess = z.infer<typeof StorageKeyAccess>;

export const bucketAccessModes = ["private", "public-read"] as const;
export const BucketAccess = z.enum(bucketAccessModes);
export type BucketAccess = z.infer<typeof BucketAccess>;

/** What an engine supports; the API and UI show "not supported by this engine" from it. */
export type StorageCapabilities = {
	versioning: boolean;
	bucketPolicy: boolean;
	accessKeys: boolean;
	usage: boolean;
	console: boolean;
};
