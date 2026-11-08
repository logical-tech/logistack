import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { egressPassword } from "@logistack/core";
import { startEgressProxy } from "../src/egress-proxy.ts";

// The egress proxy in-process: CONNECT and plain HTTP to declared hosts only, credentials per
// install, and no private address unless the manifest names it literally.

/** Sends `request` raw and returns everything the proxy answers until it closes. */
function raw(port: number, request: string, then?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const s = connect(port, "127.0.0.1");
		let out = "";
		s.on("data", (d) => {
			out += d.toString();
			if (then && out.startsWith("HTTP/1.1 200 Connection Established")) {
				s.write(then);
				then = undefined;
			}
		});
		s.on("close", () => resolve(out));
		s.on("error", reject);
		s.write(request);
	});
}

describe("egress proxy", () => {
	let target: ReturnType<typeof Bun.serve>;
	let proxy: Awaited<ReturnType<typeof startEgressProxy>>;
	let auth: string;
	let other: string;

	beforeAll(async () => {
		target = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => new Response(`hello ${new URL(req.url).pathname}`),
		});
		proxy = await startEgressProxy({
			port: 0,
			hostname: "127.0.0.1",
			key: "k",
			rules: {
				plg_a: ["127.0.0.1", "named.test"],
				plg_b: ["public.test"],
			},
			lookup: async () => ["127.0.0.1"],
		});
		auth = Buffer.from(`plg_a:${await egressPassword("k", "plg_a")}`).toString(
			"base64",
		);
		other = Buffer.from(`plg_b:${await egressPassword("k", "plg_b")}`).toString(
			"base64",
		);
	});
	afterAll(() => {
		proxy?.stop();
		target?.stop(true);
	});

	const hostPort = () => `127.0.0.1:${target.port}`;

	test("tunnels CONNECT to a declared host", async () => {
		const out = await raw(
			proxy.port,
			`CONNECT ${hostPort()} HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
			`GET /x HTTP/1.1\r\nHost: ${hostPort()}\r\nConnection: close\r\n\r\n`,
		);
		expect(out).toStartWith("HTTP/1.1 200 Connection Established");
		expect(out).toContain("hello /x");
	});

	test("forwards plain HTTP and strips the credentials", async () => {
		const out = await raw(
			proxy.port,
			`GET http://${hostPort()}/y HTTP/1.1\r\nHost: ${hostPort()}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
		);
		expect(out).toStartWith("HTTP/1.1 200");
		expect(out).toContain("hello /y");
	});

	test("asks for credentials, and refuses wrong ones", async () => {
		const none = await raw(
			proxy.port,
			`CONNECT ${hostPort()} HTTP/1.1\r\n\r\n`,
		);
		expect(none).toStartWith("HTTP/1.1 407");
		const bad = Buffer.from("plg_a:nope").toString("base64");
		expect(
			await raw(
				proxy.port,
				`CONNECT ${hostPort()} HTTP/1.1\r\nProxy-Authorization: Basic ${bad}\r\n\r\n`,
			),
		).toStartWith("HTTP/1.1 407");
	});

	test("refuses hosts the install did not declare", async () => {
		// plg_b declared public.test, not 127.0.0.1.
		expect(
			await raw(
				proxy.port,
				`CONNECT ${hostPort()} HTTP/1.1\r\nProxy-Authorization: Basic ${other}\r\n\r\n`,
			),
		).toStartWith("HTTP/1.1 403");
	});

	test("refuses a declared name that resolves to a private address", async () => {
		expect(
			await raw(
				proxy.port,
				`CONNECT named.test:${target.port} HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
			),
		).toStartWith("HTTP/1.1 403");
	});
});
