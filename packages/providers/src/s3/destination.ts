import { z } from "zod";
import {
	type BackupDestination,
	type BackupObject,
	lazyStream,
	probeKey,
} from "../backup/destination.ts";
import { defineProvider, ProviderError, secret } from "../http.ts";
import { signV4 } from "../sigv4.ts";

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

/** S3 wants each key segment RFC 3986-encoded, `/` kept. */
const encodeKey = (key: string) =>
	key
		.split("/")
		.map((seg) =>
			encodeURIComponent(seg).replace(
				/[!'()*]/g,
				(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
			),
		)
		.join("/");

const tag = (xml: string, name: string) =>
	new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

const unescapeXml = (s: string) =>
	s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&amp;/g, "&");

const sha256 = (body: Uint8Array | string) =>
	new Bun.CryptoHasher("sha256").update(body).digest("hex");

/**
 * Every request is signed here (SigV4) and sent through `deps.fetch`, so a caller can pin the
 * connection to a checked address (`pinnedFetch`). Bun's S3Client dials on its own and cannot be.
 */
export const s3Destination = defineProvider({
	configSchema: s3DestinationConfig,
	create(config, deps): S3Destination {
		const send = deps?.fetch ?? fetch;
		const endpoint = new URL(config.endpoint);
		const basePath = endpoint.pathname.replace(/\/+$/, "");
		const objectUrl = (key: string) =>
			config.forcePathStyle
				? `${endpoint.origin}${basePath}/${config.bucket}/${encodeKey(key)}`
				: `${endpoint.protocol}//${config.bucket}.${endpoint.host}${basePath}/${encodeKey(key)}`;
		const credentials = {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		};
		const root =
			config.prefix && !config.prefix.endsWith("/")
				? `${config.prefix}/`
				: config.prefix;

		async function request(
			op: string,
			method: string,
			key: string,
			init: {
				query?: Record<string, string>;
				headers?: Record<string, string>;
				body?: Uint8Array | string;
				timeout?: boolean;
			} = {},
		): Promise<Response> {
			const url = new URL(objectUrl(key));
			// URLSearchParams would send spaces as `+`, which S3 reads literally.
			url.search = Object.entries(init.query ?? {})
				.map(([k, v]) => `${encodeKey(k)}=${encodeKey(v)}`)
				.join("&");
			const headers = {
				...init.headers,
				"x-amz-content-sha256": sha256(init.body ?? ""),
			};
			const auth = await signV4(
				{ method, url: url.href, headers },
				{ credentials, region: config.region, service: "s3" },
			);
			let res: Response;
			try {
				res = await send(url.href, {
					method,
					headers: { ...headers, ...auth },
					...(init.body === undefined ? {} : { body: init.body }),
					...(init.timeout === false
						? {}
						: { signal: AbortSignal.timeout(60_000) }),
				});
			} catch (err) {
				throw new ProviderError(
					"s3",
					op,
					err instanceof Error ? err.message : String(err),
				);
			}
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				const reason =
					[tag(text, "Code"), tag(text, "Message")]
						.filter(Boolean)
						.join(": ") || `HTTP ${res.status}`;
				throw new ProviderError("s3", op, reason, res.status);
			}
			return res;
		}

		/** Reads up to `size` bytes from the iterator into one buffer; `done` once the source is spent. */
		async function fill(
			it: AsyncIterator<Uint8Array>,
			carry: { rest?: Uint8Array },
			size: number,
		): Promise<{ part: Uint8Array; done: boolean }> {
			const part = new Uint8Array(size);
			let len = 0;
			let done = false;
			while (len < size) {
				let chunk = carry.rest;
				carry.rest = undefined;
				if (!chunk) {
					const next = await it.next();
					if (next.done) {
						done = true;
						break;
					}
					chunk = next.value;
				}
				const take = Math.min(chunk.byteLength, size - len);
				part.set(chunk.subarray(0, take), len);
				len += take;
				if (take < chunk.byteLength) carry.rest = chunk.subarray(take);
			}
			return { part: part.subarray(0, len), done: done && !carry.rest };
		}

		const dest: S3Destination = {
			async probe() {
				const key = `${root}${probeKey()}`;
				const body = `logistack probe ${Date.now()}`;
				await request("probe", "PUT", key, { body });
				const read = await (await request("probe", "GET", key)).text();
				await request("probe", "DELETE", key);
				if (read !== body)
					throw new ProviderError("s3", "probe", "probe read back differs");
			},
			// One part in memory at a time, sent before the next is pulled: the source is read
			// only as fast as the store takes it.
			async upload(key, body, opts) {
				const target = `${root}${key}`;
				const type = opts?.contentType
					? { "content-type": opts.contentType }
					: undefined;
				const it = body[Symbol.asyncIterator]();
				const carry: { rest?: Uint8Array } = {};
				const first = await fill(it, carry, PART_SIZE);
				if (first.done) {
					await request("upload", "PUT", target, {
						body: first.part,
						headers: type,
						timeout: false,
					});
					return;
				}
				const created = await request("upload", "POST", target, {
					query: { uploads: "" },
					headers: type,
				});
				const uploadId = tag(await created.text(), "UploadId");
				if (!uploadId)
					throw new ProviderError("s3", "upload", "no UploadId in the answer");
				const etags: string[] = [];
				try {
					let part = first;
					for (;;) {
						const res = await request("upload", "PUT", target, {
							query: {
								partNumber: String(etags.length + 1),
								uploadId,
							},
							body: part.part,
							timeout: false,
						});
						etags.push(res.headers.get("etag") ?? "");
						if (part.done) break;
						part = await fill(it, carry, PART_SIZE);
						if (part.part.byteLength === 0 && part.done) break;
					}
					const xml = `<CompleteMultipartUpload>${etags
						.map(
							(e, i) =>
								`<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</ETag></Part>`,
						)
						.join("")}</CompleteMultipartUpload>`;
					const done = await request("upload", "POST", target, {
						query: { uploadId },
						body: xml,
						timeout: false,
					});
					// S3 can answer 200 and still fail the completion in the body.
					const text = await done.text();
					if (tag(text, "Code"))
						throw new ProviderError(
							"s3",
							"upload",
							[tag(text, "Code"), tag(text, "Message")].join(": "),
						);
				} catch (err) {
					await request("upload", "DELETE", target, {
						query: { uploadId },
					}).catch(() => {});
					await it.return?.();
					throw err;
				}
			},
			download: (key) =>
				lazyStream(async () => {
					const res = await request("download", "GET", `${root}${key}`, {
						timeout: false,
					});
					if (!res.body)
						throw new ProviderError("s3", "download", `GET ${key} had no body`);
					return res.body;
				}),
			async list(prefix = "") {
				const out: BackupObject[] = [];
				let token: string | undefined;
				do {
					const res = await request("list", "GET", "", {
						query: {
							"list-type": "2",
							prefix: `${root}${prefix}`,
							...(token ? { "continuation-token": token } : {}),
						},
					});
					const xml = await res.text();
					for (const [, item = ""] of xml.matchAll(
						/<Contents>([\s\S]*?)<\/Contents>/g,
					))
						out.push({
							key: unescapeXml(tag(item, "Key") ?? "").slice(root.length),
							size: Number(tag(item, "Size") ?? 0),
							lastModified: new Date(tag(item, "LastModified") ?? 0),
						});
					token =
						tag(xml, "IsTruncated") === "true"
							? unescapeXml(tag(xml, "NextContinuationToken") ?? "")
							: undefined;
				} while (token);
				return out;
			},
			async delete(key) {
				await request("delete", "DELETE", `${root}${key}`);
			},
		};
		return dest;
	},
});
