// Pure stream decoders: the 8-byte multiplexed frame format and JSON lines.

export type StreamKind = "stdin" | "stdout" | "stderr";

export interface Frame {
	stream: StreamKind;
	data: Uint8Array;
}

const KINDS: Record<number, StreamKind> = {
	0: "stdin",
	1: "stdout",
	2: "stderr",
};

/**
 * Incremental decoder for `application/vnd.docker.multiplexed-stream`.
 * Each frame is `[kind, 0, 0, 0, size(uint32 BE)]` followed by `size` bytes.
 * Frames may be split across or packed into chunks arbitrarily.
 */
export class Demuxer {
	#buf = new Uint8Array(0);

	push(chunk: Uint8Array): Frame[] {
		const buf = this.#buf.length ? concat(this.#buf, chunk) : chunk;
		const frames: Frame[] = [];
		let at = 0;
		while (buf.length - at >= 8) {
			const kind = KINDS[buf[at] as number];
			if (!kind)
				throw new Error(
					`invalid multiplexed stream header byte ${buf[at]} at offset ${at}`,
				);
			const size = new DataView(
				buf.buffer,
				buf.byteOffset + at + 4,
				4,
			).getUint32(0);
			if (buf.length - at - 8 < size) break;
			frames.push({ stream: kind, data: buf.slice(at + 8, at + 8 + size) });
			at += 8 + size;
		}
		this.#buf = buf.slice(at);
		return frames;
	}

	/** Bytes held back waiting for the rest of a frame. Non-zero at end of stream means truncation. */
	get pending(): number {
		return this.#buf.length;
	}
}

export async function* demux(
	body: AsyncIterable<Uint8Array>,
): AsyncGenerator<Frame> {
	const d = new Demuxer();
	for await (const chunk of body) yield* d.push(chunk);
	if (d.pending)
		throw new Error(
			`multiplexed stream ended mid-frame (${d.pending} bytes pending)`,
		);
}

export async function* rawFrames(
	body: AsyncIterable<Uint8Array>,
): AsyncGenerator<Frame> {
	for await (const data of body) yield { stream: "stdout", data };
}

export async function* jsonLines<T>(
	body: AsyncIterable<Uint8Array>,
): AsyncGenerator<T> {
	const dec = new TextDecoder();
	let rest = "";
	for await (const chunk of body) {
		rest += dec.decode(chunk, { stream: true });
		let nl = rest.indexOf("\n");
		while (nl >= 0) {
			const line = rest.slice(0, nl).trim();
			rest = rest.slice(nl + 1);
			if (line) yield JSON.parse(line) as T;
			nl = rest.indexOf("\n");
		}
	}
	const last = (rest + dec.decode()).trim();
	if (last) yield JSON.parse(last) as T;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}
