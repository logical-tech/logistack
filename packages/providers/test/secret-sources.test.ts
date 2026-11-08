import { describe, expect, test } from "bun:test";
import { instantiate, ProviderError, secretProviders } from "../src/index.ts";
import { mockFetch } from "./helpers.ts";

describe("infisical", () => {
	test("logs in once, then reads by environment, folder and name", async () => {
		const { fetch, calls } = mockFetch((c) =>
			c.url.endsWith("/login")
				? Response.json({ accessToken: "tok" })
				: Response.json({ secret: { secretValue: "s3cret" } }),
		);
		const src = instantiate(
			secretProviders.infisical,
			{ clientId: "id", clientSecret: "cs", projectId: "p1" },
			{ fetch },
		);
		expect(await src.read(["prod", "api", "db"], "DB_PASSWORD")).toBe("s3cret");
		await src.read(["prod"], "OTHER");
		expect(calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(1);
		const read = new URL(calls[1]?.url ?? "");
		expect(read.origin).toBe("https://app.infisical.com");
		expect(read.pathname).toBe("/api/v3/secrets/raw/DB_PASSWORD");
		expect(Object.fromEntries(read.searchParams)).toEqual({
			workspaceId: "p1",
			environment: "prod",
			secretPath: "/api/db",
		});
		expect(calls[1]?.headers.authorization).toBe("Bearer tok");
	});
});

describe("1password connect", () => {
	test("finds vault, item and field by name", async () => {
		const { fetch, calls } = mockFetch((c) => {
			const path = new URL(c.url).pathname;
			if (path === "/v1/vaults")
				return Response.json([{ id: "v1", name: "Prod" }]);
			if (path === "/v1/vaults/v1/items")
				return Response.json([{ id: "i1", title: "Postgres" }]);
			return Response.json({
				fields: [
					{ id: "username", label: "username", value: "app" },
					{ id: "password", label: "password", value: "pw" },
				],
			});
		});
		const src = instantiate(
			secretProviders.onepassword,
			{ url: "https://op.example.com/", token: "t" },
			{ fetch },
		);
		expect(await src.read(["Prod", "Postgres"], "password")).toBe("pw");
		expect(await src.read(["Prod", "Postgres"], "username")).toBe("app");
		expect(calls).toHaveLength(3);
		expect(calls[0]?.headers.authorization).toBe("Bearer t");
		await expect(src.read(["Prod", "Missing"], "x")).rejects.toThrow(
			'no item "Missing"',
		);
		await expect(src.read(["Prod", "Postgres"], "otp")).rejects.toBeInstanceOf(
			ProviderError,
		);
	});
});

describe("vault", () => {
	test("reads a KV v2 field and names a missing one without values", async () => {
		const { fetch, calls } = mockFetch(() =>
			Response.json({ data: { data: { password: "pw", port: 5432 } } }),
		);
		const src = instantiate(
			secretProviders.vault,
			{ url: "https://vault.example.com", token: "t", namespace: "team" },
			{ fetch },
		);
		expect(await src.read(["kv", "app", "db"], "password")).toBe("pw");
		expect(await src.read(["kv", "app", "db"], "port")).toBe("5432");
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v1/kv/data/app/db");
		expect(calls[0]?.headers["x-vault-token"]).toBe("t");
		expect(calls[0]?.headers["x-vault-namespace"]).toBe("team");
		const err = await src.read(["kv", "app", "db"], "user").catch((e) => e);
		expect(err.message).toBe('vault read: no field "user" at kv/app/db');
	});
});
