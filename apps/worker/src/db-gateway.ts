import {
	BlockList,
	connect,
	createServer,
	isIPv4,
	type Socket,
} from "node:net";
import {
	GATEWAY_MODES,
	type GatewayEnv,
	type GatewayMode,
	judgeOpening,
} from "@logistack/core";
import { log } from "./bus.ts";

// The process behind a database's public port or port forward (ROLE=dbgateway, one Swarm
// service per exposure, compiled by `compileDbGateway`). See docs/plans/database-ops.md.

/** A client that has not asked for TLS within this long is dropped. */
const OPENING_TIMEOUT_MS = 10_000;

/** `::ffff:1.2.3.4` (an IPv4 client on a dual-stack socket) is `1.2.3.4`. */
export const normalizeAddress = (a: string) =>
	a.startsWith("::ffff:") && isIPv4(a.slice(7)) ? a.slice(7) : a;

export function allowList(ranges: string[]): BlockList {
	const list = new BlockList();
	for (const r of ranges) {
		const [addr = "", bits] = r.split("/");
		const type = isIPv4(addr) ? "ipv4" : "ipv6";
		if (bits === undefined) list.addAddress(addr, type);
		else list.addSubnet(addr, Number(bits), type);
	}
	return list;
}

export const isAllowed = (list: BlockList, address: string) => {
	const a = normalizeAddress(address);
	return list.check(a, isIPv4(a) ? "ipv4" : "ipv6");
};

export type GatewayOptions = {
	port: number;
	/** Default: every interface. */
	hostname?: string;
	upstream: { host: string; port: number };
	mode: GatewayMode;
	allow: string[];
	expiresAt?: Date;
};

export type Gateway = {
	port: number;
	/** Settles once the gateway has closed, at expiry or on `stop`. */
	closed: Promise<void>;
	stop(): void;
};

export async function startGateway(o: GatewayOptions): Promise<Gateway> {
	const allow = allowList(o.allow);
	const sockets = new Set<Socket>();
	const track = (s: Socket) => {
		sockets.add(s);
		s.once("close", () => sockets.delete(s));
		return s;
	};

	const server = createServer((client) => {
		track(client);
		const from = client.remoteAddress ?? "";
		if (!isAllowed(allow, from)) {
			log("warn", "gateway refused a source address", { from });
			client.destroy();
			return;
		}
		let upstream: Socket | undefined;
		const dial = () => {
			upstream = track(connect(o.upstream.port, o.upstream.host));
			upstream.on("error", () => client.destroy());
			client.on("error", () => upstream?.destroy());
			upstream.once("close", () => client.destroy());
			client.once("close", () => upstream?.destroy());
			upstream.pipe(client);
			return upstream;
		};
		if (o.mode === "plain") {
			client.pipe(dial());
			return;
		}
		// MySQL servers speak first; the client asks for TLS in its reply to the greeting.
		if (o.mode === "mysql") dial();
		else client.on("error", () => client.destroy());
		const timer = setTimeout(() => client.destroy(), OPENING_TIMEOUT_MS);
		let seen = Buffer.alloc(0);
		const opening = (chunk: Buffer) => {
			seen = Buffer.concat([seen, chunk]);
			const verdict = judgeOpening(o.mode, seen);
			if (verdict === "more") return;
			clearTimeout(timer);
			client.off("data", opening);
			if (verdict === "refuse") {
				log("warn", "gateway refused a connection that did not ask for TLS", {
					from,
				});
				client.destroy();
				return;
			}
			client.pause();
			const up = upstream ?? dial();
			up.write(seen);
			client.pipe(up);
		};
		client.on("data", opening);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(o.port, o.hostname, () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : o.port;

	let finish!: () => void;
	const closed = new Promise<void>((r) => {
		finish = r;
	});
	let expiry: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		clearTimeout(expiry);
		server.close(() => finish());
		for (const s of sockets) s.destroy();
	};
	if (o.expiresAt) {
		// setTimeout caps at 2^31-1 ms; forwards last hours, never weeks.
		expiry = setTimeout(stop, Math.max(0, o.expiresAt.getTime() - Date.now()));
	}
	return { port, closed, stop };
}

/** Reads `GatewayEnv`, set by `compileDbGateway`. */
export function gatewayOptions(env: Record<string, string | undefined>) {
	const e = env as Partial<GatewayEnv>;
	const [host, port] = (e.LS_GW_UPSTREAM ?? "").split(/:(?=\d+$)/);
	if (!host || !port || !e.LS_GW_LISTEN)
		throw new Error("LS_GW_LISTEN and LS_GW_UPSTREAM are required");
	const mode = GATEWAY_MODES.find((m) => m === e.LS_GW_MODE);
	if (!mode) throw new Error(`LS_GW_MODE must be one of ${GATEWAY_MODES}`);
	return {
		port: Number(e.LS_GW_LISTEN),
		upstream: { host, port: Number(port) },
		mode,
		allow: (e.LS_GW_ALLOW ?? "").split(",").filter(Boolean),
		...(e.LS_GW_EXPIRES_AT ? { expiresAt: new Date(e.LS_GW_EXPIRES_AT) } : {}),
	} satisfies GatewayOptions;
}

if (import.meta.main) {
	const opts = gatewayOptions(process.env);
	if (opts.expiresAt && opts.expiresAt.getTime() <= Date.now()) {
		log("info", "gateway expired before it started");
		process.exit(0);
	}
	const gw = await startGateway(opts);
	log("info", "gateway listening", {
		port: gw.port,
		mode: opts.mode,
		expiresAt: opts.expiresAt?.toISOString() ?? null,
	});
	for (const sig of ["SIGTERM", "SIGINT"] as const)
		process.on(sig, () => gw.stop());
	await gw.closed;
	log("info", "gateway closed");
	process.exit(0);
}
