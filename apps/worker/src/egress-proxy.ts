import { BlockList, connect, createServer, isIP, type Socket } from "node:net";
// Subpaths, not the barrels: the proxy loads only what it runs.
import { egressAllowed, egressPassword } from "@logistack/core/plugin-egress";
import { resolvePublic } from "@logistack/providers/ssrf";

const log = (level: string, msg: string, fields: object = {}) =>
	console.log(
		JSON.stringify({ level, msg, at: new Date().toISOString(), ...fields }),
	);

// The plugin egress proxy (ROLE=egressproxy, one Swarm service compiled by
// `compileEgressProxy`). Plugins sit on an internal overlay; this is their only way out. It
// speaks HTTP CONNECT (https and anything else over TLS) and plain absolute-form HTTP, checks
// the install's Basic credentials, and connects only to hosts that install's manifest declares,
// never to a private address unless the manifest names that address literally.

const HEAD_LIMIT = 16 * 1024;

// Never reachable, even named literally: cloud metadata lives here. (ls-control is refused by resolvePublic.)
const linkLocal = new BlockList();
linkLocal.addSubnet("169.254.0.0", 16, "ipv4");
linkLocal.addSubnet("fe80::", 10, "ipv6");
const HEAD_TIMEOUT_MS = 10_000;

export type EgressProxyOptions = {
	port: number;
	hostname?: string;
	key: string;
	rules: Record<string, string[]>;
	/** Tests resolve names themselves. */
	lookup?: (host: string) => Promise<string[]>;
};

type Head = {
	method: string;
	target: string;
	version: string;
	headers: [string, string][];
	rest: Buffer;
};

function parseHead(buf: Buffer): Head | "more" | "bad" {
	const end = buf.indexOf("\r\n\r\n");
	if (end < 0) return buf.length > HEAD_LIMIT ? "bad" : "more";
	const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
	const [method = "", target = "", version = ""] = (lines[0] ?? "").split(" ");
	if (!method || !target || !version.startsWith("HTTP/")) return "bad";
	const headers: [string, string][] = [];
	for (const l of lines.slice(1)) {
		const i = l.indexOf(":");
		if (i > 0) headers.push([l.slice(0, i).trim(), l.slice(i + 1).trim()]);
	}
	return { method, target, version, headers, rest: buf.subarray(end + 4) };
}

const reply = (status: string, extra = "") =>
	`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n${extra}\r\n`;

function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

export async function startEgressProxy(o: EgressProxyOptions) {
	const sockets = new Set<Socket>();
	const track = (s: Socket) => {
		sockets.add(s);
		s.once("close", () => sockets.delete(s));
		return s;
	};

	async function installOf(head: Head): Promise<string | undefined> {
		const auth = head.headers.find(
			([k]) => k.toLowerCase() === "proxy-authorization",
		)?.[1];
		const m = /^Basic\s+(.+)$/i.exec(auth ?? "");
		if (!m?.[1]) return undefined;
		const [id = "", password = ""] = Buffer.from(m[1], "base64")
			.toString()
			.split(":");
		if (!o.rules[id]) return undefined;
		return safeEqual(password, await egressPassword(o.key, id))
			? id
			: undefined;
	}

	async function handle(client: Socket, head: Head) {
		const id = await installOf(head);
		if (!id) {
			client.end(
				reply(
					"407 Proxy Authentication Required",
					'Proxy-Authenticate: Basic realm="logistack"\r\n',
				),
			);
			return;
		}
		let host: string;
		let port: number;
		let tunnel = false;
		let path = "";
		if (head.method === "CONNECT") {
			const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(head.target);
			if (!m?.[1] || !m[2]) return void client.end(reply("400 Bad Request"));
			host = m[1].replace(/^\[|\]$/g, "");
			port = Number(m[2]);
			tunnel = true;
		} else {
			let url: URL;
			try {
				url = new URL(head.target);
			} catch {
				return void client.end(reply("400 Bad Request"));
			}
			if (url.protocol !== "http:")
				return void client.end(reply("400 Bad Request"));
			host = url.hostname.replace(/^\[|\]$/g, "");
			port = Number(url.port || 80);
			path = `${url.pathname}${url.search}`;
		}
		if (!egressAllowed(o.rules[id] ?? [], host)) {
			log("warn", "egress refused: host not declared", { installId: id, host });
			return void client.end(reply("403 Forbidden"));
		}
		let address: string;
		try {
			// A private address only when the manifest names it literally.
			address = await resolvePublic(
				host,
				{ allowPrivateHosts: isIP(host) !== 0 },
				o.lookup,
			);
			if (linkLocal.check(address, isIP(address) === 4 ? "ipv4" : "ipv6"))
				throw new Error(`${address} is link-local`);
		} catch (e) {
			log("warn", "egress refused: address", {
				installId: id,
				host,
				error: e instanceof Error ? e.message : String(e),
			});
			return void client.end(reply("403 Forbidden"));
		}
		const upstream = track(connect(port, address));
		upstream.once("error", () => {
			if (!client.destroyed) client.end(reply("502 Bad Gateway"));
		});
		client.on("error", () => upstream.destroy());
		upstream.once("close", () => client.destroy());
		client.once("close", () => upstream.destroy());
		upstream.once("connect", () => {
			if (tunnel) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			else {
				const drop = new Set([
					"proxy-authorization",
					"proxy-connection",
					"connection",
					"keep-alive",
				]);
				const lines = head.headers
					.filter(([k]) => !drop.has(k.toLowerCase()))
					.map(([k, v]) => `${k}: ${v}\r\n`)
					.join("");
				// One request per connection: a second one could name another host.
				upstream.write(
					`${head.method} ${path} ${head.version}\r\n${lines}Connection: close\r\n\r\n`,
				);
			}
			if (head.rest.length) upstream.write(head.rest);
			client.pipe(upstream);
			upstream.pipe(client);
			client.resume();
		});
	}

	const server = createServer((client) => {
		track(client);
		client.on("error", () => client.destroy());
		const timer = setTimeout(() => client.destroy(), HEAD_TIMEOUT_MS);
		let seen = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			seen = Buffer.concat([seen, chunk]);
			const head = parseHead(seen);
			if (head === "more") return;
			clearTimeout(timer);
			client.off("data", onData);
			client.pause();
			if (head === "bad") return void client.end(reply("400 Bad Request"));
			handle(client, head).catch(() => client.destroy());
		};
		client.on("data", onData);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(o.port, o.hostname, () => resolve());
	});
	const address = server.address();
	return {
		port: typeof address === "object" && address ? address.port : o.port,
		stop() {
			server.close();
			for (const s of sockets) s.destroy();
		},
	};
}

if (import.meta.main) {
	const env = process.env;
	if (!env.LS_EGRESS_KEY) throw new Error("LS_EGRESS_KEY is required");
	const proxy = await startEgressProxy({
		port: Number(env.LS_EGRESS_LISTEN ?? 3128),
		key: env.LS_EGRESS_KEY,
		rules: JSON.parse(env.LS_EGRESS_RULES ?? "{}"),
	});
	log("info", "egress proxy listening", { port: proxy.port });
	for (const sig of ["SIGTERM", "SIGINT"] as const)
		process.on(sig, () => {
			proxy.stop();
			process.exit(0);
		});
}
