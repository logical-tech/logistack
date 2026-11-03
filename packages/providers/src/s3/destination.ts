import { S3Client } from "bun";
import { z } from "zod";
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

export type S3Object = { key: string; size: number; lastModified: Date };

export interface S3Destination {
	/** Writes, reads back and deletes a probe object. */
	test(): Promise<void>;
	/** Streams to a multipart upload; the body is never buffered whole. */
	upload(
		key: string,
		body: ReadableStream<Uint8Array>,
		opts?: { contentType?: string },
	): Promise<void>;
	download(key: string): ReadableStream<Uint8Array>;
	/** Keys are relative to the destination prefix. */
	list(prefix?: string): Promise<S3Object[]>;
	delete(key: string): Promise<void>;
}

const PART_SIZE = 16 * 1024 * 1024;

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
			async test() {
				const key = `.logistack-probe-${crypto.randomUUID()}`;
				const body = `logistack probe ${Date.now()}`;
				await wrap("test", async () => {
					await client.write(`${root}${key}`, body);
					const read = await client.file(`${root}${key}`).text();
					await client.delete(`${root}${key}`);
					if (read !== body)
						throw new ProviderError("s3", "test", "probe read back differs");
				});
			},
			upload: (key, body, opts) =>
				wrap("upload", async () => {
					await client.write(`${root}${key}`, new Response(body), {
						type: opts?.contentType,
						partSize: PART_SIZE,
					});
				}),
			download: (key) => client.file(`${root}${key}`).stream(),
			list: (prefix = "") =>
				wrap("list", async () => {
					const out: S3Object[] = [];
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
