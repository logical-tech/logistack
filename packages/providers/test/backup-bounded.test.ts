import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type BackupDestination,
	instantiate,
	s3Destination,
} from "../src/index.ts";

// Both directions of an S3 destination hold a bounded window however slow the far side is.

const MiB = 1024 * 1024;
let server: Bun.Subprocess<"ignore", "pipe", "inherit">;
let base: string;
let dest: BackupDestination;
const stats = async () =>
	(await (await fetch(`${base}/_stats`)).json()) as {
		received: number;
		served: number;
	};

beforeAll(async () => {
	server = Bun.spawn(["bun", join(import.meta.dir, "fixtures/slow-s3.ts")], {
		stdout: "pipe",
		stderr: "inherit",
	});
	const reader = server.stdout.getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	base = `http://127.0.0.1:${new TextDecoder().decode(value).trim()}`;
	dest = instantiate(s3Destination, {
		endpoint: base,
		bucket: "bounded",
		accessKeyId: "test",
		secretAccessKey: "test-secret",
		forcePathStyle: true,
	});
});
afterAll(() => server.kill());

test("an upload to a slow store pulls at most a few parts ahead of it", async () => {
	const total = 96 * MiB;
	let pulled = 0;
	let ahead = 0;
	const source = new ReadableStream<Uint8Array>(
		{
			pull(c) {
				if (pulled >= total) return c.close();
				pulled += MiB;
				c.enqueue(new Uint8Array(MiB));
			},
		},
		{ highWaterMark: 0 },
	);
	const done = dest.upload("backups/p/big.dump", source);
	let finished = false;
	void done.finally(() => {
		finished = true;
	});
	while (!finished) {
		ahead = Math.max(ahead, pulled - (await stats()).received);
		await Bun.sleep(100);
	}
	await done;
	expect(pulled).toBe(total);
	// About one 16 MiB part; Bun's write(key, new Response(stream)) ran 39 MiB ahead here and
	// keeps growing with a longer source.
	expect(ahead).toBeLessThan(24 * MiB);
}, 60_000);

test("a slow reader holds a download back to the socket buffers", async () => {
	const before = (await stats()).served;
	const reader = dest.download("backups/p/big.dump").getReader();
	let read = 0;
	for (let i = 0; i < 20; i++) {
		const { value } = await reader.read();
		read += value?.byteLength ?? 0;
		await Bun.sleep(50);
	}
	const served = (await stats()).served - before;
	await reader.cancel();
	expect(read).toBeGreaterThan(0);
	// Of a 256 MiB object; Bun's S3 file stream fetched all of it into memory by the first read.
	expect(served).toBeLessThan(32 * MiB);
}, 60_000);
