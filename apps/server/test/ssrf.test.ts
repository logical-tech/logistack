import { afterAll, describe, expect, test } from "bun:test";
import { checkGit, checkImage } from "../src/probe.ts";
import { guardedDestination } from "../src/s3.ts";
import {
	BlockedHostError,
	guardedFetch,
	isPrivateAddress,
	pinnedFetch,
	resolvePublic,
} from "../src/ssrf.ts";

const deny = { allowPrivateHosts: false };
const allow = { allowPrivateHosts: true };

describe("isPrivateAddress", () => {
	test.each([
		["127.0.0.1", true],
		["127.255.0.9", true],
		["10.1.2.3", true],
		["172.16.0.1", true],
		["172.31.255.255", true],
		["192.168.1.1", true],
		["169.254.169.254", true],
		["100.100.100.200", true],
		["100.64.0.1", true],
		["0.0.0.0", true],
		["224.0.0.1", true],
		["255.255.255.255", true],
		["::1", true],
		["::", true],
		["fe80::1", true],
		["fd00:ec2::254", true],
		["fc00::1", true],
		["::ffff:127.0.0.1", true],
		["::ffff:a9fe:a9fe", true],
		["64:ff9b::a9fe:a9fe", true],
		["2002:7f00:1::", true],
		["::127.0.0.1", true],
		["::a9fe:a9fe", true],
		["::ffff:0:7f00:1", true],
		["::ffff:8.8.8.8", false],
		["not-an-ip", true],
		["8.8.8.8", false],
		["1.1.1.1", false],
		["140.82.121.33", false],
		["172.32.0.1", false],
		["192.169.0.1", false],
		["2606:4700:4700::1111", false],
		["2a00:1450:4001::200e", false],
	])("%s is private: %p", (address, expected) => {
		expect(isPrivateAddress(address)).toBe(expected);
	});
});

describe("resolvePublic", () => {
	const answers =
		(...addresses: string[]) =>
		async () =>
			addresses;

	test("returns the checked address to pin", async () => {
		expect(await resolvePublic("ghcr.io", deny, answers("140.82.121.33"))).toBe(
			"140.82.121.33",
		);
	});

	test("refuses when any answer is private, so rebinding to a second record fails", async () => {
		await expect(
			resolvePublic("evil.example", deny, answers("8.8.8.8", "127.0.0.1")),
		).rejects.toBeInstanceOf(BlockedHostError);
	});

	test("refuses IP literals in private ranges, bracketed IPv6 too", async () => {
		await expect(resolvePublic("169.254.169.254", deny)).rejects.toThrow(
			"private address",
		);
		await expect(resolvePublic("[::1]", deny)).rejects.toThrow(
			"private address",
		);
	});

	test("refuses names that do not resolve", async () => {
		await expect(
			resolvePublic("nx.example", deny, async () => {
				throw new Error("ENOTFOUND");
			}),
		).rejects.toThrow("does not resolve");
	});

	test("the instance setting lets private hosts through", async () => {
		expect(
			await resolvePublic("registry.lan", allow, answers("10.0.0.5")),
		).toBe("10.0.0.5");
	});

	test("ls-control stays refused even when private hosts are allowed", async () => {
		await expect(
			resolvePublic("caddy.lan", allow, answers("10.247.0.4")),
		).rejects.toThrow("control network");
		await expect(resolvePublic("[::ffff:10.247.0.4]", allow)).rejects.toThrow(
			"control network",
		);
	});
});

describe("guardedFetch", () => {
	test("refuses plain http and private targets before connecting", async () => {
		await expect(
			guardedFetch("http://example.com/", {}, deny),
		).rejects.toBeInstanceOf(BlockedHostError);
		await expect(
			guardedFetch("https://localhost/", {}, deny),
		).rejects.toBeInstanceOf(BlockedHostError);
	});
});

describe("DNS rebinding", () => {
	/** A local stand-in that records every request it gets. */
	const seen: { host: string | null; path: string }[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			seen.push({
				host: req.headers.get("host"),
				path: new URL(req.url).pathname,
			});
			return new Response("logistack probe", { status: 200 });
		},
	});
	afterAll(() => server.stop(true));

	/** Answers public first, then the private address: what a rebinding name server does. */
	const rebinding = () => {
		let calls = 0;
		return async () => (calls++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
	};

	test("an S3 endpoint that rebinds after the check is never dialled", async () => {
		seen.length = 0;
		const dest = await guardedDestination(
			{
				endpoint: `https://s3.rebind.test:${server.port}`,
				region: "us-east-1",
				bucket: "backups",
				prefix: "",
				accessKeyId: "k",
				secretAccessKey: "s",
				forcePathStyle: true,
			},
			deny,
			rebinding(),
		);
		const err = await dest.probe().then(
			() => undefined,
			(e: Error) => e,
		);
		expect(err?.message).toContain("private address");
		expect(seen).toEqual([]);
	});

	test("pinnedFetch connects to the checked address and keeps the Host header", async () => {
		seen.length = 0;
		const res = await pinnedFetch(allow, {
			privateHttp: true,
			resolve: async () => ["127.0.0.1"],
		})(`http://storage.rebind.test:${server.port}/bucket/key`);
		expect(res.status).toBe(200);
		expect(seen).toEqual([
			{ host: `storage.rebind.test:${server.port}`, path: "/bucket/key" },
		]);
	});

	test("pinnedFetch re-checks every request", async () => {
		const guarded = pinnedFetch(deny, { resolve: rebinding() });
		// The first answer passes the check; the aborted signal keeps the test off the network.
		await expect(
			guarded("https://api.rebind.test/v1", { signal: AbortSignal.abort() }),
		).rejects.toHaveProperty("name", "AbortError");
		await expect(guarded("https://api.rebind.test/v1")).rejects.toBeInstanceOf(
			BlockedHostError,
		);
	});
});

describe("source checks", () => {
	test("an image on a loopback registry is refused", async () => {
		expect(await checkImage("127.0.0.1:5000/app:1", deny)).toMatchObject({
			ok: false,
			message: "This host isn't allowed",
		});
	});

	test("a git remote on the metadata address is refused", async () => {
		expect(
			await checkGit(
				{
					type: "git",
					repository: "https://169.254.169.254/latest",
					branch: "main",
				} as Parameters<typeof checkGit>[0],
				deny,
			),
		).toMatchObject({ ok: false, message: "This host isn't allowed" });
	});
});
