import { describe, expect, test } from "bun:test";
import {
	type Fetch,
	ProviderError,
	pluginDnsProvider,
	pluginNotificationChannel,
	pluginProviderCall,
	pluginSecretSource,
	testEvent,
	testRendered,
	verifyPluginRequest,
} from "../src/index.ts";

// The proxies that turn a plugin's contract into DnsProvider, NotificationChannel and
// SecretSource: signed requests to /v1/providers/{kind}/{name}/{op}, answers checked.

const target = {
	baseUrl: "http://plugin.test",
	installId: "plg_test",
	signingSecret: "s3cret",
};

type Seen = { path: string; body: { config: unknown; args: unknown[] } };

function fake(answer: (op: string, args: unknown[]) => unknown, status = 200) {
	const seen: Seen[] = [];
	const f: Fetch = async (url, init) => {
		const body = String(init?.body);
		expect(
			await verifyPluginRequest(
				target.signingSecret,
				new Headers(init?.headers as Record<string, string>),
				{ method: init?.method ?? "GET", path: new URL(url).pathname },
				body,
			),
		).toBe(true);
		const path = new URL(url).pathname;
		const parsed = JSON.parse(body) as Seen["body"];
		seen.push({ path, body: parsed });
		const op = path.split("/").at(-1) ?? "";
		return new Response(
			status === 200
				? JSON.stringify({ result: answer(op, parsed.args) })
				: JSON.stringify({ error: "boom" }),
			{ status },
		);
	};
	return { f, seen };
}

describe("plugin DNS provider", () => {
	test("each op is a signed call with config and positional args", async () => {
		const rec = {
			id: "r1",
			zoneId: "z",
			name: "_acme-challenge.example.com",
			type: "TXT",
			content: "tok",
			ttl: 60,
		};
		const { f, seen } = fake((op) =>
			op === "listZones"
				? [{ id: "z", name: "example.com" }]
				: op === "upsertRecord"
					? rec
					: op === "listRecords"
						? [rec]
						: null,
		);
		const dns = pluginDnsProvider(
			pluginProviderCall(target, "dnsProviders", "memory", { token: "t" }, f),
		);
		await dns.verify();
		expect(await dns.listZones()).toEqual([{ id: "z", name: "example.com" }]);
		const input = {
			zoneId: "z",
			name: rec.name,
			type: "TXT" as const,
			content: "tok",
			ttl: 60,
		};
		expect(await dns.upsertRecord(input)).toEqual(rec as never);
		expect(await dns.listRecords("z", rec.name)).toHaveLength(1);
		await dns.deleteRecord("z", "r1");
		expect(seen.map((s) => s.path)).toEqual([
			"/v1/providers/dnsProviders/memory/verify",
			"/v1/providers/dnsProviders/memory/listZones",
			"/v1/providers/dnsProviders/memory/upsertRecord",
			"/v1/providers/dnsProviders/memory/listRecords",
			"/v1/providers/dnsProviders/memory/deleteRecord",
		]);
		expect(seen[2]?.body).toEqual({ config: { token: "t" }, args: [input] });
		expect(seen[4]?.body.args).toEqual(["z", "r1"]);
	});

	test("an answer of the wrong shape is refused", async () => {
		const { f } = fake(() => [{ id: 1 }]);
		const dns = pluginDnsProvider(
			pluginProviderCall(target, "dnsProviders", "memory", {}, f),
		);
		await expect(dns.listZones()).rejects.toThrow("unexpected result");
	});

	test("a plugin error is a ProviderError with its status", async () => {
		const { f } = fake(() => null, 502);
		const dns = pluginDnsProvider(
			pluginProviderCall(target, "dnsProviders", "memory", {}, f),
		);
		const err = await dns.verify().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).status).toBe(502);
		expect((err as Error).message).toContain("boom");
	});
});

test("plugin notification channel sends the event and its rendering", async () => {
	const { f, seen } = fake(() => null);
	const ch = pluginNotificationChannel(
		pluginProviderCall(target, "notificationChannels", "log", {}, f),
	);
	await ch.send(testEvent, testRendered);
	await ch.test();
	expect(seen[0]?.path).toBe("/v1/providers/notificationChannels/log/send");
	expect(seen[0]?.body.args[1]).toEqual(testRendered);
	expect(seen[1]?.path).toBe("/v1/providers/notificationChannels/log/test");
});

test("plugin secret source reads a string, nothing else", async () => {
	const { f, seen } = fake((_op, args) =>
		(args[1] as string) === "password" ? "pw" : 42,
	);
	const src = pluginSecretSource(
		pluginProviderCall(target, "secretProviders", "memory", {}, f),
	);
	expect(await src.read(["app", "db"], "password")).toBe("pw");
	expect(seen[0]?.body.args).toEqual([["app", "db"], "password"]);
	await expect(src.read(["app"], "other")).rejects.toThrow("unexpected result");
});
