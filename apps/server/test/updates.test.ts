import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	LIVE_CHANNEL,
	type LiveMessage,
	updateChannel,
} from "@logistack/contracts";
import { auditLog, instanceUpdate } from "@logistack/db";
import { RedisClient } from "bun";
import { eq } from "drizzle-orm";
import { websocket } from "../src/ws.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const release = {
	tag_name: "v0.2.0",
	name: "v0.2.0",
	body: "## Features\n\n- feat(web): updates page",
	html_url: "https://github.com/logical-tech/logistack/releases/tag/v0.2.0",
	published_at: "2026-11-01T10:00:00Z",
	draft: false,
	prerelease: false,
};

describe.skipIf(!hasDocker)("updates", () => {
	let h: Harness;
	let cookie: string;
	let asked = 0;
	const real = globalThis.fetch;
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		globalThis.fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			if (String(input).startsWith("https://api.github.com/")) {
				asked++;
				return Response.json(release);
			}
			return real(input, init);
		}) as typeof fetch;
		h = await startHarness({
			area: "rel",
			label: "rel",
			env: { LOGISTACK_VERSION: "0.1.0", LOGISTACK_COMMIT: "abc1234" },
		});
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
	}, 60_000);
	afterAll(async () => {
		globalThis.fetch = real;
		await h?.close();
	});

	test("GET /api/version reports the baked version", async () => {
		const r = await h.call("GET", "/api/version", as());
		expect(r.status).toBe(200);
		expect(r.json).toEqual({ version: "0.1.0", commit: "abc1234" });
	});

	test("the status names the latest release and asks GitHub once per hour", async () => {
		const r = await h.call("GET", "/api/instance/update", as());
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({
			current: { version: "0.1.0", commit: "abc1234" },
			latest: { version: "0.2.0", name: "v0.2.0", notes: release.body },
			latestError: null,
			updateAvailable: true,
			autoCheck: true,
			run: null,
		});
		await h.call("GET", "/api/instance/update", as());
		// A forced refresh within a minute of the last ask is served from the cache too.
		await h.call("GET", "/api/instance/update?refresh=true", as());
		expect(asked).toBe(1);
		expect((await h.call("GET", "/api/instance/update")).status).toBe(401);
	});

	test("an admin queues one update at a time, forward only, audited", async () => {
		const bad = await h.call("POST", "/api/instance/update", {
			...as(),
			body: { version: "latest" },
		});
		expect(bad.status).toBe(400);
		const back = await h.call("POST", "/api/instance/update", {
			...as(),
			body: { version: "0.1.0" },
		});
		expect(back.status).toBe(409);

		const r = await h.call("POST", "/api/instance/update", {
			...as(),
			body: { version: "v0.2.0" },
		});
		expect(r.status).toBe(202);
		expect(r.json).toMatchObject({
			fromVersion: "0.1.0",
			toVersion: "0.2.0",
			state: "queued",
		});
		const again = await h.call("POST", "/api/instance/update", {
			...as(),
			body: { version: "0.2.0" },
		});
		expect(again.status).toBe(409);

		const status = await h.call("GET", "/api/instance/update", as());
		expect(status.json.run).toMatchObject({ id: r.json.id, state: "queued" });
		const [audit] = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.resourceId, r.json.id));
		expect(audit).toMatchObject({
			action: "instance.upgrade",
			outcome: "success",
			diff: { from: "0.1.0", to: "0.2.0" },
		});

		// The database refuses a second active run even past the API's own check.
		await expect(
			h.deps.db
				.insert(instanceUpdate)
				.values({ fromVersion: "0.1.0", toVersion: "0.3.0" })
				.execute(),
		).rejects.toThrow();
	});

	test("/ws relays the updater's progress frames for a run", async () => {
		const [run] = await h.deps.db.select().from(instanceUpdate);
		const channel = updateChannel(run?.id ?? "");
		const server = Bun.serve({ port: 0, fetch: h.app.fetch, websocket });
		const redis = new RedisClient(h.config.REDIS_URL);
		try {
			const ws = new WebSocket(`ws://localhost:${server.port}/ws`, {
				headers: { cookie },
			});
			const frames: unknown[] = [];
			ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
			await new Promise((r) => {
				ws.onopen = r;
			});
			ws.send(JSON.stringify({ type: "subscribe", channel }));
			const until = async (n: number) => {
				for (let i = 0; i < 50 && frames.length < n; i++) await Bun.sleep(50);
			};
			await until(1);
			const frame: LiveMessage = {
				kind: "update",
				channel,
				state: "running",
				steps: { pull: "done", "logistack-api": "running" },
				line: "Updating logistack_logistack-api",
			};
			await redis.publish(LIVE_CHANNEL, JSON.stringify(frame));
			await until(2);
			expect(frames).toEqual([
				{ type: "subscribed", channel },
				{ type: "data", channel, data: frame },
			]);
			ws.close();
		} finally {
			redis.close();
			server.stop(true);
		}
	});

	test("the daily check can be turned off", async () => {
		const r = await h.call("PUT", "/api/instance/update/auto-check", {
			...as(),
			body: { enabled: false },
		});
		expect(r.status).toBe(200);
		const status = await h.call("GET", "/api/instance/update", as());
		expect(status.json.autoCheck).toBe(false);
	});
});
