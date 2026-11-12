import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	HomeDnsRecordInput,
	HomeDnsSettings,
	homeDnsRecordId,
} from "@logistack/contracts";
import { type Technitium, TechnitiumError, technitium } from "../src/index.ts";

// Bridge networking with published ports, so it runs beside anything holding the host's 53 and 5380.
const NAME = `ls-test-homedns-client-${crypto.randomUUID().slice(0, 8)}`;
const IMAGE = "technitium/dns-server:15.6.2";
const PASSWORD = "client-test-password";
const hasDocker =
	Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" })
		.exitCode === 0;

describe.skipIf(!hasDocker)("Technitium client against a real server", () => {
	let base: string;
	let api: Technitium;
	let session: string;

	beforeAll(async () => {
		const run = Bun.spawnSync([
			"docker",
			"run",
			"-d",
			"--name",
			NAME,
			"--label",
			"logistack.test=homedns",
			"-e",
			`DNS_SERVER_ADMIN_PASSWORD=${PASSWORD}`,
			"-p",
			"127.0.0.1::5380",
			IMAGE,
		]);
		if (run.exitCode !== 0) throw new Error(run.stderr.toString());
		base = `http://${Bun.spawnSync(["docker", "port", NAME, "5380/tcp"]).stdout.toString().trim().split("\n")[0]}`;
		for (let i = 0; ; i++)
			try {
				await technitium(base).ping();
				break;
			} catch (e) {
				if (i > 120) throw e;
				await Bun.sleep(500);
			}
		session = await technitium(base).login("admin", PASSWORD);
		api = technitium(base, await technitium(base, session).createToken("test"));
	}, 120_000);

	afterAll(() => {
		Bun.spawnSync(["docker", "rm", "-f", "-v", NAME]);
	});

	test("a wrong password and a bad token are typed errors", async () => {
		expect(technitium(base).login("admin", "nope")).rejects.toThrow(
			TechnitiumError,
		);
		const err = await technitium(base, "bad")
			.zones()
			.catch((e) => e);
		expect(err).toBeInstanceOf(TechnitiumError);
		expect(err.invalidToken).toBe(true);
	});

	test("settings apply and read back", async () => {
		expect(await api.version()).toBe("15.6.2");
		await api.applySettings(
			HomeDnsSettings.parse({
				upstream: { servers: ["1.1.1.1", "9.9.9.9"], protocol: "Udp" },
				dnssecValidation: false,
				blocking: { enabled: true, listUrls: [] },
			}),
		);
		const res = await fetch(`${base}/api/settings/get`, {
			method: "POST",
			headers: { authorization: `Bearer ${session}` },
		}).then((r) => r.json() as Promise<{ response: unknown }>);
		expect(res.response).toMatchObject({
			forwarders: ["1.1.1.1", "9.9.9.9"],
			forwarderProtocol: "Udp",
			dnssecValidation: false,
			enableBlocking: true,
			blockListUrls: null,
		});
	});

	test("zones and every record type round-trip through add, list, update and delete", async () => {
		await api.createZone("home.lan");
		expect(api.createZone("home.lan")).rejects.toThrow("Zone already exists");
		expect((await api.zones()).map((z) => z.name)).toEqual(["home.lan"]);
		const inputs = [
			{
				name: "nas.home.lan",
				type: "A",
				content: "192.168.1.10",
				ttl: 300,
				comment: "the NAS",
			},
			{ name: "v6.home.lan", type: "AAAA", content: "fd00::1" },
			{ name: "www.home.lan", type: "CNAME", content: "nas.home.lan" },
			{ name: "home.lan", type: "TXT", content: "v=spf1 -all" },
			{ name: "home.lan", type: "MX", content: "10 mail.home.lan" },
			{
				name: "_sip._tcp.home.lan",
				type: "SRV",
				content: "1 2 5060 nas.home.lan",
			},
			{ name: "10.home.lan", type: "PTR", content: "nas.home.lan" },
		].map((r) => HomeDnsRecordInput.parse(r));
		for (const r of inputs) await api.addRecord("home.lan", r);
		const listed = await api.records("home.lan");
		for (const r of inputs)
			expect(listed).toContainEqual({
				id: homeDnsRecordId(r),
				name: r.name,
				type: r.type,
				content: r.content,
				ttl: r.ttl,
				...(r.comment ? { comment: r.comment } : {}),
				disabled: false,
			});

		const [a, , cname, txt, mx, srv] = inputs as [
			HomeDnsRecordInput,
			HomeDnsRecordInput,
			HomeDnsRecordInput,
			HomeDnsRecordInput,
			HomeDnsRecordInput,
			HomeDnsRecordInput,
		];
		const updates: [HomeDnsRecordInput, HomeDnsRecordInput][] = [
			[a, { ...a, name: "nas2.home.lan", content: "192.168.1.11" }],
			[cname, { ...cname, content: "nas2.home.lan" }],
			[txt, { ...txt, content: "hello" }],
			[mx, { ...mx, content: "20 mx.home.lan" }],
			[srv, { ...srv, content: "5 6 5061 nas2.home.lan" }],
			// A type change re-creates the record.
			[
				inputs[1] as HomeDnsRecordInput,
				{ ...a, name: "v6.home.lan", content: "192.168.1.12" },
			],
		];
		for (const [from, to] of updates)
			await api.updateRecord("home.lan", from, to);
		const after = (await api.records("home.lan")).map(
			(r) => `${r.name} ${r.type} ${r.content}`,
		);
		for (const [from, to] of updates) {
			expect(after).toContain(`${to.name} ${to.type} ${to.content}`);
			expect(after).not.toContain(`${from.name} ${from.type} ${from.content}`);
		}
		for (const [, to] of updates) await api.deleteRecord("home.lan", to);
		await api.deleteRecord("home.lan", inputs[6] as HomeDnsRecordInput);
		expect(await api.records("home.lan")).toEqual([]);

		expect((await api.resolve("nas.home.lan")).rcode).toBe("NxDomain");
		await api.deleteZone("home.lan");
		expect(await api.zones()).toEqual([]);
	});

	test("a forwarder zone answers its wildcard with the LAN address", async () => {
		await api.createForwarderZone("split.example.com");
		expect((await api.zones()).map((z) => [z.name, z.type])).toContainEqual([
			"split.example.com",
			"Forwarder",
		]);
		// Hostname refuses wildcards from users; the worker writes this one itself.
		await api.addRecord("split.example.com", {
			name: "*.split.example.com",
			type: "A",
			content: "192.168.1.39",
			ttl: 300,
		});
		expect(
			(await api.records("split.example.com")).map((r) => r.name),
		).toContain("*.split.example.com");
		const r = await api.resolve("logistack.split.example.com");
		expect(r.answers).toContainEqual({ type: "A", data: "192.168.1.39" });
	});

	test("allowed and blocked lists, and the resolver says when a name was blocked", async () => {
		await api.block("ads.example.com");
		await api.allow("good.example.com");
		expect(await api.blocked()).toEqual(["ads.example.com"]);
		expect(await api.allowed()).toEqual(["good.example.com"]);
		const blocked = await api.resolve("ads.example.com");
		expect(blocked).toMatchObject({ blocked: true, rcode: "NxDomain" });
		await api.unblock("ads.example.com");
		await api.disallow("good.example.com");
		expect(await api.blocked()).toEqual([]);
		expect(await api.allowed()).toEqual([]);
		await api.forceUpdateBlockLists();
	});

	test("stats parse, and the query log reports the missing extension", async () => {
		const stats = await api.stats("hour");
		expect(Object.keys(stats.totals)).toHaveLength(11);
		expect(stats.chart.labels).toHaveLength(60);
		expect(stats.chart.series.map((s) => s.label)).toContain("Blocked");
		expect(await api.apps()).toEqual([]);
		expect(api.queryLogs({ page: 1, perPage: 10 })).rejects.toThrow(
			TechnitiumError,
		);
	});
});
