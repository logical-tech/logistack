import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { type EventEnvelope, eventTypes } from "@logistack/contracts";
import { z } from "zod";
import {
	instantiate,
	matchRules,
	type NotificationRule,
	notificationChannels,
	ProviderError,
	renderEvent,
	signWebhook,
	verifyWebhookSignature,
} from "../src/index.ts";
import { mockFetch } from "./helpers.ts";

const event: EventEnvelope = {
	id: "evt_1",
	type: "deployment.failed",
	organizationId: "org_1",
	resource: { type: "deployment", id: "dep_1" },
	payload: {
		name: "api",
		error: "build exited with code 1",
		project: "shop",
		environment: "production",
		commit: "a1b2c3d",
		url: "https://ls.example.com/deployments/dep_1",
		projectId: "prj_1",
		serviceId: "svc_1",
	},
	at: new Date("2026-11-03T10:00:00Z"),
};

describe("renderEvent", () => {
	test("deployment.failed", () => {
		expect(renderEvent(event)).toEqual({
			title: "Deployment failed: api",
			body: "build exited with code 1\nProject: shop\nEnvironment: production\nCommit: a1b2c3d\nAt: 2026-11-03T10:00:00.000Z",
			severity: "error",
			url: "https://ls.example.com/deployments/dep_1",
		});
	});
	test("every event type renders, even with an empty payload", () => {
		for (const type of eventTypes) {
			const r = renderEvent({ ...event, type, payload: {} });
			expect(r.title.length).toBeGreaterThan(0);
			expect(r.url).toBeUndefined();
		}
		expect(
			renderEvent({ ...event, type: "node.down", payload: {} }).severity,
		).toBe("error");
		expect(
			renderEvent({ ...event, type: "certificate.expiring", payload: {} })
				.severity,
		).toBe("warning");
	});
});

describe("matchRules", () => {
	const rule = (
		id: string,
		over: Partial<NotificationRule> = {},
	): NotificationRule => ({
		id,
		events: ["deployment.failed"],
		scope: {},
		channelId: `nch_${id}`,
		enabled: true,
		...over,
	});

	test("event type × scope, each channel once", () => {
		const rules = [
			rule("a"),
			rule("b", { scope: { projectId: "prj_1" } }),
			rule("c", { scope: { projectId: "prj_2" } }),
			rule("d", { scope: { projectId: "prj_1", serviceId: "svc_1" } }),
			rule("e", { scope: { serviceId: "svc_9" } }),
			rule("f", { events: ["deployment.succeeded"] }),
			rule("g", { enabled: false }),
			rule("h", { channelId: "nch_a" }),
		];
		expect(matchRules(event, rules)).toEqual(["nch_a", "nch_b", "nch_d"]);
	});

	test("scope comes from the resource when it is a service", () => {
		const e = {
			...event,
			resource: { type: "service", id: "svc_7" },
			payload: {},
		};
		const rules = [
			rule("a", { scope: { serviceId: "svc_7" } }),
			rule("b", { scope: { projectId: "prj_1" } }),
		];
		expect(matchRules(e, rules)).toEqual(["nch_a"]);
	});
});

describe("channel payloads", () => {
	const rendered = renderEvent(event);
	const configs: Record<string, unknown> = {
		slack: { webhookUrl: "https://hooks.slack.com/services/T/B/x" },
		discord: { webhookUrl: "https://discord.com/api/webhooks/1/x" },
		telegram: { botToken: "123:abc", chatId: "-100" },
		teams: {
			webhookUrl: "https://prod.westeurope.logic.azure.com/workflows/x",
		},
		mattermost: { webhookUrl: "https://mm.example.com/hooks/x" },
		ntfy: { topic: "logistack-alerts", token: "tk_x" },
		gotify: { serverUrl: "https://gotify.example.com/", appToken: "AppTok" },
		pushover: { appToken: "app", userKey: "user" },
		webhook: {
			url: "https://hooks.example.com/ls",
			secret: "0123456789abcdef",
		},
		email: {
			transport: "resend",
			apiKey: "re_x",
			from: "LogiStack <ls@example.com>",
			to: ["ops@example.com"],
		},
	};

	beforeAll(() => setSystemTime(new Date("2026-11-03T10:00:05Z")));
	afterAll(() => setSystemTime());

	for (const [kind, config] of Object.entries(configs))
		test(kind, async () => {
			const m = mockFetch(() => new Response("ok"));
			const def =
				notificationChannels[kind as keyof typeof notificationChannels];
			await instantiate(def, config, m).send(event, rendered);
			const [c] = m.calls;
			expect({
				method: c?.method,
				url: c?.url,
				headers: c?.headers,
				body: JSON.parse(c?.body ?? ""),
			}).toMatchSnapshot();
		});

	test("test() sends the fixed test message", async () => {
		const m = mockFetch(() => new Response("ok"));
		await notificationChannels.slack
			.create({ webhookUrl: "https://hooks.slack.com/x" }, m)
			.test();
		expect(m.calls[0]?.body).toContain("LogiStack test notification");
	});

	test("rejections become ProviderError without the token", async () => {
		const m = mockFetch(
			() => new Response('{"description":"chat not found"}', { status: 400 }),
		);
		const err = await notificationChannels.telegram
			.create({ botToken: "123:secret", chatId: "1" }, m)
			.test()
			.catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.status).toBe(400);
		expect(err.message).not.toContain("123:secret");
	});

	test("config schemas mark credentials as secret", () => {
		const schema = z.toJSONSchema(
			notificationChannels.pushover.configSchema,
		) as {
			properties: Record<string, { secret?: boolean }>;
		};
		expect(schema.properties.appToken?.secret).toBe(true);
		expect(schema.properties.userKey?.secret).toBe(true);
	});

	test("config schemas reject bad input", () => {
		expect(() =>
			instantiate(notificationChannels.webhook, {
				url: "https://x",
				secret: "short",
			}),
		).toThrow();
		expect(() =>
			instantiate(notificationChannels.ntfy, { topic: "has space" }),
		).toThrow();
	});
});

describe("outgoing webhook signature", () => {
	const key = "0123456789abcdef";
	const body = '{"hello":"world"}';
	const now = 1_800_000_000;
	const headers = async (ts: number, b = body) =>
		new Headers({
			"x-logistack-timestamp": String(ts),
			"x-logistack-signature": await signWebhook(key, ts, b),
		});

	test("valid inside the replay window", async () => {
		expect(
			await verifyWebhookSignature(key, await headers(now - 299), body, now),
		).toBe(true);
	});
	test("tampered body", async () => {
		expect(
			await verifyWebhookSignature(
				key,
				await headers(now),
				'{"hello":"mallory"}',
				now,
			),
		).toBe(false);
	});
	test("stale timestamp", async () => {
		expect(
			await verifyWebhookSignature(key, await headers(now - 301), body, now),
		).toBe(false);
	});
	test("missing signature", async () => {
		expect(
			await verifyWebhookSignature(
				key,
				new Headers({ "x-logistack-timestamp": String(now) }),
				body,
				now,
			),
		).toBe(false);
	});
	test("sent headers verify", async () => {
		const m = mockFetch(() => new Response("ok"));
		await notificationChannels.webhook
			.create({ url: "https://hooks.example.com/", secret: key }, m)
			.send(event, renderEvent(event));
		const c = m.calls[0];
		expect(
			await verifyWebhookSignature(key, new Headers(c?.headers), c?.body ?? ""),
		).toBe(true);
	});
});
