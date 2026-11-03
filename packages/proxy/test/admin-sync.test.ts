import { afterAll, expect, test } from "bun:test";
import {
	CaddyAdmin,
	CaddyAdminError,
	coalesce,
	compileProxy,
	ProxySync,
} from "../src/index.ts";
import { input } from "./fixtures.ts";

const config = compileProxy(input);
const loads: unknown[] = [];

// Stands in for the Caddy admin API: /load accepts, /fail answers like Caddy does on a bad config.
const fake = Bun.serve({
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (
			path === "/load" &&
			req.headers.get("content-type") === "application/json"
		) {
			loads.push(await req.json());
			return new Response(null, { status: 200 });
		}
		if (path === "/config/") return Response.json(loads.at(-1) ?? null);
		if (path === "/slow/load") {
			await Bun.sleep(500);
			return new Response(null);
		}
		return Response.json(
			{
				error:
					"loading new config: http app module: start: listening on :80: bind",
			},
			{ status: 400 },
		);
	},
});
afterAll(() => fake.stop(true));
const base = `http://127.0.0.1:${fake.port}`;

test("load posts JSON and getConfig reads it back", async () => {
	const admin = new CaddyAdmin(base);
	expect(await admin.getConfig()).toBeNull();
	await admin.load(config);
	expect(await admin.getConfig()).toEqual(JSON.parse(JSON.stringify(config)));
});

test("a rejected load surfaces Caddy's error body", async () => {
	const err = await new CaddyAdmin(`${base}/bad`).load(config).catch((e) => e);
	expect(err).toBeInstanceOf(CaddyAdminError);
	expect(err.failure).toEqual({
		kind: "http",
		status: 400,
		body: '{"error":"loading new config: http app module: start: listening on :80: bind"}',
	});
	expect(err.message).toContain("listening on :80");
});

test("a slow endpoint times out", async () => {
	const err = await new CaddyAdmin(`${base}/slow`, 50)
		.load(config)
		.catch((e) => e);
	expect(err.failure).toEqual({ kind: "timeout", timeoutMs: 50 });
});

test("an unreachable endpoint is a network failure", async () => {
	const err = await new CaddyAdmin("http://127.0.0.1:1", 1000)
		.load(config)
		.catch((e) => e);
	expect(err.failure.kind).toBe("network");
});

test("ProxySync reports each instance separately", async () => {
	const results = await new ProxySync([base, `${base}/bad`]).push(config);
	expect(results.map((r) => [r.endpoint, r.ok])).toEqual([
		[base, true],
		[`${base}/bad`, false],
	]);
	const failed = results[1];
	expect(failed?.ok === false && failed.error.failure.kind).toBe("http");
});

test("coalesce: calls within the window run once with the last value", async () => {
	const seen: number[] = [];
	const push = coalesce(async (v: number) => {
		seen.push(v);
		return v * 10;
	}, 30);
	const results = await Promise.all([push(1), push(2), push(3)]);
	expect(seen).toEqual([3]);
	expect(results).toEqual([30, 30, 30]);
	expect(await push(4)).toBe(40);
	expect(seen).toEqual([3, 4]);
});

test("coalesce: a newer batch never overlaps or overtakes a slow older one", async () => {
	const events: string[] = [];
	const push = coalesce(async (v: string) => {
		events.push(`start ${v}`);
		await Bun.sleep(v === "old" ? 80 : 1);
		events.push(`end ${v}`);
	}, 10);
	const first = push("old");
	await Bun.sleep(20);
	await Promise.all([first, push("new")]);
	expect(events).toEqual(["start old", "end old", "start new", "end new"]);
});

test("coalesce: a failure rejects every caller in the batch", async () => {
	const push = coalesce(async () => {
		throw new Error("boom");
	}, 5);
	const results = await Promise.allSettled([push(1), push(2)]);
	expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
});
