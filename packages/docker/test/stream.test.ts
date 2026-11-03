import { describe, expect, test } from "bun:test";
import { Demuxer, demux, jsonLines } from "../src/stream.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(kind: number, text: string): Uint8Array {
	const data = enc.encode(text);
	const out = new Uint8Array(8 + data.length);
	out[0] = kind;
	new DataView(out.buffer).setUint32(4, data.length);
	out.set(data, 8);
	return out;
}

function join(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

async function* chunks(...parts: Uint8Array[]) {
	yield* parts;
}

const decoded = (frames: { stream: string; data: Uint8Array }[]) =>
	frames.map((f) => [f.stream, dec.decode(f.data)]);

describe("Demuxer", () => {
	const wire = join(
		frame(1, "hello\n"),
		frame(2, "oops\n"),
		frame(1, ""),
		frame(1, "x".repeat(70000)),
	);

	test("decodes frames packed in one chunk", () => {
		expect(decoded(new Demuxer().push(wire))).toEqual([
			["stdout", "hello\n"],
			["stderr", "oops\n"],
			["stdout", ""],
			["stdout", "x".repeat(70000)],
		]);
	});

	test("decodes the same frames when fed one byte at a time", () => {
		const d = new Demuxer();
		const frames = [];
		for (let i = 0; i < wire.length; i++)
			frames.push(...d.push(wire.subarray(i, i + 1)));
		expect(decoded(frames)).toEqual(decoded(new Demuxer().push(wire)));
		expect(d.pending).toBe(0);
	});

	test("holds back a split header and payload", () => {
		const d = new Demuxer();
		const f = frame(2, "split");
		expect(d.push(f.subarray(0, 5))).toEqual([]);
		expect(d.push(f.subarray(5, 10))).toEqual([]);
		expect(decoded(d.push(f.subarray(10)))).toEqual([["stderr", "split"]]);
	});

	test("rejects a non-multiplexed stream instead of returning garbage", () => {
		expect(() => new Demuxer().push(enc.encode("plain tty output"))).toThrow(
			/invalid multiplexed/,
		);
	});

	test("demux() fails on a truncated stream", async () => {
		const f = frame(1, "truncated");
		const run = async () => {
			for await (const _ of demux(chunks(f.subarray(0, 12)))) {
			}
		};
		await expect(run()).rejects.toThrow(/ended mid-frame/);
	});
});

describe("jsonLines", () => {
	test("parses objects split across chunks, including multibyte characters", async () => {
		const text = enc.encode('{"a":1}\n{"b":"café"}\n\n{"c":3}');
		const out = [];
		for await (const v of jsonLines(
			chunks(text.subarray(0, 3), text.subarray(3, 18), text.subarray(18)),
		))
			out.push(v);
		expect(out).toEqual([{ a: 1 }, { b: "café" }, { c: 3 }]);
	});
});
