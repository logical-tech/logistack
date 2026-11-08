/** A stored backup; keys are relative to the destination's root. */
export type BackupObject = { key: string; size: number; lastModified: Date };

/**
 * Where backups go: S3, an rclone remote, or a folder on a node. Every byte streams through;
 * an implementation holds at most a bounded window of it in memory.
 */
export interface BackupDestination {
	/** Writes, reads back and deletes a probe object; throws with the store's reason. */
	probe(): Promise<void>;
	/** Pulls `body` only as fast as the store takes it. */
	upload(
		key: string,
		body: ReadableStream<Uint8Array>,
		opts?: { contentType?: string },
	): Promise<void>;
	/** Errors the stream when the read fails partway. */
	download(key: string): ReadableStream<Uint8Array>;
	list(prefix?: string): Promise<BackupObject[]>;
	delete(key: string): Promise<void>;
}

/** The probe's key: hidden, unique, and outside every policy's `backups/` prefix. */
export const probeKey = () => `.logistack-probe-${crypto.randomUUID()}`;

/** Upload, read back and delete a short probe through the interface itself. */
export async function probeRoundTrip(dest: BackupDestination) {
	const key = probeKey();
	const sent = `logistack probe ${Date.now()}`;
	await dest.upload(key, new Response(sent).body as ReadableStream<Uint8Array>);
	try {
		const read = await new Response(dest.download(key)).text();
		if (read !== sent) throw new Error("the probe read back differs");
	} finally {
		await dest.delete(key);
	}
}

/** A stream that opens its source on the first read and reads it no faster than it is read. */
export function lazyStream(
	open: () => Promise<AsyncIterable<Uint8Array>>,
): ReadableStream<Uint8Array> {
	let it: AsyncIterator<Uint8Array> | undefined;
	return new ReadableStream<Uint8Array>(
		{
			async pull(c) {
				it ??= (await open())[Symbol.asyncIterator]();
				const { value, done } = await it.next();
				if (done) c.close();
				else c.enqueue(value);
			},
			async cancel() {
				await it?.return?.();
			},
		},
		{ highWaterMark: 0 },
	);
}
