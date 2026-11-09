import { describe, expect, test } from "bun:test";
import { PLUGIN_MANIFEST_LABEL } from "@logistack/contracts";
import type { Db } from "@logistack/db";
import { manifestFromImage, parseImageRef } from "../src/plugins.ts";

describe("parseImageRef", () => {
	test("hosts, Docker Hub library images, tags and digests", () => {
		expect(parseImageRef("ghcr.io/acme/x:1.2")).toEqual({
			host: "ghcr.io",
			repo: "acme/x",
			reference: "1.2",
		});
		expect(parseImageRef("nginx")).toEqual({
			host: "docker.io",
			repo: "library/nginx",
			reference: "latest",
		});
		expect(parseImageRef("localhost:5000/a/b@sha256:abc")).toEqual({
			host: "localhost:5000",
			repo: "a/b",
			reference: "sha256:abc",
		});
		expect(() => parseImageRef("bad ref; rm -rf")).toThrow();
	});
});

describe("manifestFromImage", () => {
	const manifest = { id: "com.acme.x", version: "1.0.0", name: "X" };
	const indexDigest = "sha256:index";
	// A registry with a multi-arch index whose images carry the manifest label.
	const registry = async (url: string | URL | Request) => {
		const u = String(url);
		if (u.endsWith("/manifests/1.0"))
			return new Response(
				JSON.stringify({
					manifests: [
						{
							digest: "sha256:arm",
							platform: { os: "linux", architecture: "arm64" },
						},
						{
							digest: "sha256:amd",
							platform: { os: "linux", architecture: "amd64" },
						},
					],
				}),
				{ headers: { "docker-content-digest": indexDigest } },
			);
		if (/\/manifests\/sha256:(arm|amd)$/.test(u))
			return Response.json({ config: { digest: "sha256:cfg" } });
		if (u.endsWith("/blobs/sha256:cfg"))
			return Response.json({
				config: {
					Labels: { [PLUGIN_MANIFEST_LABEL]: JSON.stringify(manifest) },
				},
			});
		return new Response("not found", { status: 404 });
	};

	test("reads the label through the index and pins the index digest", async () => {
		const r = await manifestFromImage(
			{} as Db,
			{} as CryptoKey,
			"org",
			"registry.example.com/acme/x:1.0",
			undefined,
			registry as typeof fetch,
		);
		expect(r.image).toBe(`registry.example.com/acme/x@${indexDigest}`);
		expect(r.manifest.id).toBe("com.acme.x");
		expect(r.manifest.port).toBe(8080);
	});

	test("an image without the label is refused", async () => {
		const plain = async (url: string | URL | Request) =>
			String(url).endsWith("/blobs/sha256:cfg")
				? Response.json({ config: { Labels: {} } })
				: registry(url);
		await expect(
			manifestFromImage(
				{} as Db,
				{} as CryptoKey,
				"org",
				"registry.example.com/acme/x:1.0",
				undefined,
				plain as typeof fetch,
			),
		).rejects.toThrow("is not a LogiStack plugin");
	});

	test("a blob redirect to storage is followed through the same fetch", async () => {
		const seen: string[] = [];
		const redirecting = async (url: string | URL | Request) => {
			const u = String(url);
			seen.push(u);
			if (u.endsWith("/blobs/sha256:cfg"))
				return new Response(null, {
					status: 307,
					headers: { location: "https://cdn.example/cfg?sig=1" },
				});
			if (u === "https://cdn.example/cfg?sig=1")
				return registry("https://x/blobs/sha256:cfg");
			return registry(url);
		};
		const r = await manifestFromImage(
			{} as Db,
			{} as CryptoKey,
			"org",
			"registry.example.com/acme/x:1.0",
			undefined,
			redirecting as typeof fetch,
		);
		expect(r.manifest.id).toBe("com.acme.x");
		expect(seen).toContain("https://cdn.example/cfg?sig=1");
	});

	test("without a fetch, a registry on a private address is refused", async () => {
		const db = {
			select: () => ({ from: () => ({ where: async () => [] }) }),
		} as unknown as Db;
		await expect(
			manifestFromImage(db, {} as CryptoKey, "org", "10.0.0.5:5000/acme/x:1.0"),
		).rejects.toThrow("private address");
	});

	test("a missing tag says so", async () => {
		await expect(
			manifestFromImage(
				{} as Db,
				{} as CryptoKey,
				"org",
				"registry.example.com/acme/x:2.0",
				undefined,
				registry as typeof fetch,
			),
		).rejects.toThrow("was not found");
	});
});
