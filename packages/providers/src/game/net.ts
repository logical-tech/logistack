import dgram from "node:dgram";
import net from "node:net";

export const PROBE_TIMEOUT_MS = 3000;

/** One UDP request; resolves with the first datagram `accept` takes, or rejects on timeout. */
export function udpExchange(
	host: string,
	port: number,
	send: Uint8Array,
	accept: (msg: Buffer, reply: (b: Uint8Array) => void) => boolean,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const sock = dgram.createSocket(net.isIPv6(host) ? "udp6" : "udp4");
		const done = (fn: () => void) => {
			clearTimeout(timer);
			sock.close();
			fn();
		};
		const timer = setTimeout(
			() => done(() => reject(new Error(`no answer from ${host}:${port}`))),
			timeoutMs,
		);
		const reply = (b: Uint8Array) => sock.send(b, port, host);
		sock.on("error", (e) => done(() => reject(e)));
		sock.on("message", (msg) => {
			try {
				if (accept(msg, reply)) done(() => resolve(msg));
			} catch (e) {
				done(() => reject(e));
			}
		});
		reply(send);
	});
}

/**
 * A TCP connection read as a byte stream: `read(n)` waits for exactly n bytes, `readLine()` for a
 * `\n`-terminated line. Every wait is bounded by the timeout.
 */
export async function tcpStream(
	host: string,
	port: number,
	timeoutMs = PROBE_TIMEOUT_MS,
) {
	const sock = net.connect({ host, port });
	sock.setTimeout(timeoutMs);
	let buf = Buffer.alloc(0);
	let waiter: (() => void) | undefined;
	let failure: Error | undefined;
	const wake = () => {
		const w = waiter;
		waiter = undefined;
		w?.();
	};
	sock.on("data", (d: Buffer) => {
		buf = Buffer.concat([buf, d]);
		wake();
	});
	sock.on("timeout", () => {
		failure = new Error(`timed out talking to ${host}:${port}`);
		sock.destroy();
		wake();
	});
	sock.on("error", (e) => {
		failure = e;
		wake();
	});
	sock.on("close", () => {
		failure ??= new Error(`${host}:${port} closed the connection`);
		wake();
	});
	await new Promise<void>((resolve, reject) => {
		sock.once("connect", resolve);
		sock.once("error", reject);
		sock.once("timeout", () =>
			reject(new Error(`timed out connecting to ${host}:${port}`)),
		);
	});

	async function until(ready: () => boolean) {
		while (!ready()) {
			if (failure) throw failure;
			await new Promise<void>((r) => {
				waiter = r;
			});
		}
	}
	return {
		write: (b: Uint8Array | string) =>
			new Promise<void>((resolve, reject) =>
				sock.write(b, (e) => (e ? reject(e) : resolve())),
			),
		async read(n: number): Promise<Buffer> {
			await until(() => buf.length >= n);
			const out = buf.subarray(0, n);
			buf = buf.subarray(n);
			return out;
		},
		async readLine(): Promise<string> {
			await until(() => buf.includes(0x0a));
			const i = buf.indexOf(0x0a);
			const line = buf.subarray(0, i).toString("utf8").replace(/\r/g, "");
			buf = buf.subarray(i + 1);
			return line;
		},
		/** Bytes that arrive within `ms` of now, without waiting for a count. */
		async drain(ms: number): Promise<Buffer> {
			await new Promise((r) => setTimeout(r, ms));
			const out = buf;
			buf = Buffer.alloc(0);
			return out;
		},
		close: () => sock.destroy(),
	};
}
export type TcpStream = Awaited<ReturnType<typeof tcpStream>>;
