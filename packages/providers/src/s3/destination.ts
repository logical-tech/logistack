import { S3Client } from "bun";
import { z } from "zod";
import {
	type BackupDestination,
	type BackupObject,
	lazyStream,
	probeKey,
} from "../backup/destination.ts";
import { defineProvider, ProviderError, secret } from "../http.ts";

export const s3DestinationConfig = z.object({
	endpoint: z.url(),
	region: z.string().min(1).default("us-east-1"),
	bucket: z.string().min(3),
	/** Joined to every key; a trailing slash is added when missing. */
	prefix: z.string().default(""),
	accessKeyId: z.string().min(1),
	secretAccessKey: secret(),
	/** Path-style URLs (`endpoint/bucket/key`), needed by MinIO and most self-hosted stores. */
	forcePathStyle: z.boolean().default(false),
});
export type S3DestinationConfig = z.infer<typeof s3DestinationConfig>;

/** @deprecated use BackupObject */
export type S3Object = BackupObject;
/** @deprecated use BackupDestination */
export type S3Destination = BackupDestination;

const PART_SIZE = 16 * 1024 * 1024;
/** A presigned read must outlive the slowest restore that starts with it. */
const DOWNLOAD_URL_TTL_S = 7 * 3600;

export const s3Destination = defineProvider({
	configSchema: s3DestinationConfig,
	create(config): S3Destination {
		const client = new S3Client({
			endpoint: config.endpoint,
			region: config.region,
			bucket: config.bucket,
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			virtualHostedStyle: !config.forcePathStyle,
		});
		const root =
			config.prefix && !config.prefix.endsWith("/")
				? `${config.prefix}/`
				: config.prefix;

		async function wrap<T>(op: string, fn: () => Promise<T>): Promise<T> {
			try {
				return await fn();
			} catch (err) {
				if (err instanceof ProviderError) throw err;
				const e = err as { message?: string; code?: string };
				throw new ProviderError(
					"s3",
					op,
					[e.code, e.message].filter(Boolean).join(": ") || String(err),
				);
			}
		}

		const dest: S3Destination = {
			async probe() {
				const key = `${root}${probeKey()}`;
				const body = `logistack probe ${Date.now()}`;
				await wrap("probe", async () => {
					await client.write(key, body);
					const read = await client.file(key).text();
					await client.delete(key);
					if (read !== body)
						throw new ProviderError("s3", "probe", "probe read back differs");
				});
			},
			// Not client.write(key, new Response(body)): Bun pulls that stream as fast as it can and
			// queues parts in memory while S3 is slow. A flush per part holds one part at a time.
			upload: (key, body, opts) =>
				wrap("upload", async () => {
					const writer = client
						.file(
							`${root}${key}`,
							opts?.contentType ? { type: opts.contentType } : {},
						)
						.writer({ partSize: PART_SIZE, queueSize: 2, retry: 3 });
					let pending = 0;
					for await (const chunk of body) {
						writer.write(chunk);
						pending += chunk.byteLength;
						if (pending >= PART_SIZE) {
							await writer.flush();
							pending = 0;
						}
					}
					await writer.end();
				}),
			// Not client.file(key).stream(): Bun reads that whole object into memory ahead of the
			// reader. A presigned fetch streams with the socket's backpressure.
			download: (key) =>
				lazyStream(async () => {
					const url = client.presign(`${root}${key}`, {
						method: "GET",
						expiresIn: DOWNLOAD_URL_TTL_S,
					});
					const res = await fetch(url);
					if (!res.ok || !res.body) {
						await res.body?.cancel();
						throw new ProviderError(
							"s3",
							"download",
							`GET ${key} answered ${res.status}`,
						);
					}
					return res.body;
				}),
			list: (prefix = "") =>
				wrap("list", async () => {
					const out: BackupObject[] = [];
					let continuationToken: string | undefined;
					do {
						const page = await client.list({
							prefix: `${root}${prefix}`,
							continuationToken,
						});
						for (const o of page.contents ?? [])
							out.push({
								key: o.key.slice(root.length),
								size: o.size ?? 0,
								lastModified: new Date(o.lastModified ?? 0),
							});
						continuationToken = page.isTruncated
							? page.nextContinuationToken
							: undefined;
					} while (continuationToken);
					return out;
				}),
			delete: (key) => wrap("delete", () => client.delete(`${root}${key}`)),
		};
		return dest;
	},
});
