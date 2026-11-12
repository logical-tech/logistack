import { expect, test } from "bun:test";
import { type Io, run } from "../src/commands.ts";

function harness() {
	const calls: { method: string; path: string; body?: unknown }[] = [];
	const out: string[] = [];
	const io: Io = {
		out: (s) => out.push(s),
		err: () => {},
		prompt: async () => "",
		interactive: false,
		color: false,
		env: { LOGISTACK_URL: "http://ls.test", LOGISTACK_API_KEY: "lss_x" },
		fetch: (async (url: string, init: RequestInit) => {
			const path = new URL(url).pathname.replace("/api", "");
			calls.push({
				method: init.method ?? "GET",
				path,
				...(init.body ? { body: JSON.parse(init.body as string) } : {}),
			});
			const json =
				path === "/nodes"
					? [{ id: "nod_1", hostname: "home", address: "192.168.1.2" }]
					: {
							enabled: true,
							status: "starting",
							nodeHostname: "home",
							lanAddress: "192.168.1.2",
						};
			return Response.json(json);
		}) as unknown as typeof fetch,
	};
	return { io, calls, out };
}

test("network enable picks the only node, its address and the default block list", async () => {
	const h = harness();
	expect(await run(["network", "enable", "--zone", "home.lan"], h.io)).toBe(0);
	const post = h.calls.find((c) => c.method === "POST");
	expect(post).toMatchObject({
		path: "/network/dns",
		body: {
			nodeId: "nod_1",
			lanAddress: "192.168.1.2",
			settings: { localZone: "home.lan", blocking: { enabled: true } },
		},
	});
	expect(h.out.join()).toContain("starting on home (192.168.1.2)");
});

test("network disable refuses without --yes when nobody can confirm", async () => {
	const h = harness();
	expect(await run(["network", "disable"], h.io)).toBe(64);
	expect(h.calls).toEqual([]);
	expect(await run(["network", "disable", "--yes"], h.io)).toBe(0);
	expect(h.calls).toEqual([{ method: "DELETE", path: "/network/dns" }]);
});
