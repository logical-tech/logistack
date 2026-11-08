import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditLog, member, ssoProvider, user } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { joinOrganization } from "../src/sso.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const ISSUER = "https://example.com/idp";
const SECRET = "s3cret-client-value-never-returned";

const discovery = {
	issuer: ISSUER,
	authorization_endpoint: "https://example.com/idp/authorize",
	token_endpoint: "https://example.com/idp/token",
	userinfo_endpoint: "https://example.com/idp/userinfo",
	jwks_uri: "https://example.com/idp/jwks",
	scopes_supported: ["openid", "email", "profile", "groups"],
	token_endpoint_auth_methods_supported: ["client_secret_post"],
};

const cert = readFileSync(
	join(import.meta.dir, "fixtures", "custom-cert.pem"),
	"utf8",
)
	.replace(/-----[A-Z ]+-----/g, "")
	.replace(/\s+/g, "");

const samlMetadata = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://example.com/saml/idp">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://example.com/saml/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

/** Serves the discovery document for the pinned example.com issuer; everything else goes out for real. */
function mockIssuer() {
	const real = globalThis.fetch;
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const host = new Headers(init?.headers).get("host");
		if (
			host === "example.com" &&
			url.pathname === "/idp/.well-known/openid-configuration"
		)
			return Response.json(discovery);
		return real(input, init);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = real;
	};
}

const oidcBody = (providerId: string) => ({
	providerId,
	issuer: ISSUER,
	clientId: "logistack-client-1234",
	clientSecret: SECRET,
	domain: "example.com",
	defaultRole: "developer",
});

describe.skipIf(!hasDocker)("sso providers", () => {
	let h: Harness;
	let orgId: string;
	let ownerCookie: string;
	let devCookie: string;
	let restore: () => void;
	const asOwner = () => ({ headers: { cookie: ownerCookie } });

	beforeAll(async () => {
		restore = mockIssuer();
		h = await startHarness({ area: "sso", label: "sso" });
		orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		ownerCookie = await h.signIn(owner.email, owner.password);
		const dev = {
			name: "Dana Dev",
			email: "dana@example.com",
			password: "dana password 12",
		};
		await h.call("POST", "/api/auth/sign-up/email", { body: dev });
		const [u] = await h.deps.db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, dev.email));
		await h.deps.db.insert(member).values({
			id: crypto.randomUUID(),
			organizationId: orgId,
			userId: u?.id ?? "",
			role: "developer",
			createdAt: new Date(),
		});
		devCookie = await h.signIn(dev.email, dev.password);
	}, 90_000);
	afterAll(async () => {
		restore?.();
		await h?.close();
	});

	test("a non-admin is denied creating a provider, and the denial is audited", async () => {
		const res = await h.call("POST", "/api/sso/providers/oidc", {
			headers: { cookie: devCookie },
			body: oidcBody("denied-idp"),
		});
		expect(res.status).toBe(403);
		const rows = await h.deps.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "sso_provider.create"),
					eq(auditLog.outcome, "denied"),
				),
			);
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows[0]?.diff)).not.toContain(SECRET);
	});

	test("better-auth's own provider mutations are not reachable over HTTP", async () => {
		const res = await h.call("POST", "/api/auth/sso/register", {
			...asOwner(),
			body: { providerId: "raw", issuer: ISSUER, domain: "example.com" },
		});
		expect(res.status).toBe(404);
	});

	test("discovery returns the issuer's endpoints and scopes", async () => {
		const res = await h.call(
			"GET",
			`/api/sso/discovery?issuer=${encodeURIComponent(ISSUER)}`,
			asOwner(),
		);
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({
			issuer: ISSUER,
			tokenEndpoint: discovery.token_endpoint,
			scopesSupported: discovery.scopes_supported,
		});
	});

	test("the public status flips to enabled after a create, and the secret is never returned", async () => {
		expect((await h.call("GET", "/api/sso/status")).json).toEqual({
			enabled: false,
		});
		const created = await h.call("POST", "/api/sso/providers/oidc", {
			...asOwner(),
			body: oidcBody("acme-idp"),
		});
		expect(created.status).toBe(201);
		expect(created.json).toEqual({
			providerId: "acme-idp",
			type: "oidc",
			issuer: ISSUER,
			domain: "example.com",
			defaultRole: "developer",
			clientIdLastFour: "1234",
		});
		const listed = await h.call("GET", "/api/sso/providers", asOwner());
		expect(listed.json).toEqual([created.json]);
		for (const body of [created.json, listed.json])
			expect(JSON.stringify(body)).not.toContain(SECRET);
		const [audit] = await h.deps.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "sso_provider.create"),
					eq(auditLog.outcome, "success"),
				),
			);
		expect(audit?.resourceId).toBe("acme-idp");
		expect(JSON.stringify(audit?.diff)).not.toContain(SECRET);

		const status = await h.call("GET", "/api/sso/status");
		expect(status.json).toEqual({ enabled: true });
	});

	test("a SAML provider registers from pasted metadata", async () => {
		const res = await h.call("POST", "/api/sso/providers/saml", {
			...asOwner(),
			body: {
				providerId: "acme-saml",
				metadataXml: samlMetadata,
				domain: "saml.example.com",
				defaultRole: "viewer",
			},
		});
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({
			type: "saml",
			issuer: "https://example.com/saml/idp",
			defaultRole: "viewer",
		});
	});

	test("auto-join gives the provider's default role to matching email domains only, once", async () => {
		const [provider] = await h.deps.db
			.select()
			.from(ssoProvider)
			.where(eq(ssoProvider.providerId, "acme-idp"));
		if (!provider) throw new Error("provider missing");
		expect(provider.organizationId).toBe(orgId);
		const newUser = async (email: string) => {
			const id = crypto.randomUUID();
			const now = new Date();
			await h.deps.db.insert(user).values({
				id,
				name: email,
				email,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			});
			return { id, email };
		};
		const roleOf = async (userId: string) =>
			(
				await h.deps.db
					.select({ role: member.role })
					.from(member)
					.where(
						and(eq(member.userId, userId), eq(member.organizationId, orgId)),
					)
			).map((m) => m.role);

		const sam = await newUser("sam@Example.com");
		expect(await joinOrganization(h.deps.db, sam, provider)).toBe("joined");
		expect(await roleOf(sam.id)).toEqual(["developer"]);
		expect(await joinOrganization(h.deps.db, sam, provider)).toBe(
			"already-member",
		);
		expect(await roleOf(sam.id)).toEqual(["developer"]);

		// Racing first sign-ins: the unique (organization, user) index lets one insert win.
		const kim = await newUser("kim@example.com");
		const raced = await Promise.all(
			Array.from({ length: 6 }, () =>
				joinOrganization(h.deps.db, kim, provider),
			),
		);
		expect(raced.filter((r) => r === "joined")).toHaveLength(1);
		expect(await roleOf(kim.id)).toEqual(["developer"]);

		const outsider = await newUser("eve@elsewhere.org");
		expect(await joinOrganization(h.deps.db, outsider, provider)).toBe(
			"skipped",
		);
		expect(await roleOf(outsider.id)).toEqual([]);
	});

	test("deleting a provider clears it and its default role", async () => {
		const res = await h.call(
			"DELETE",
			"/api/sso/providers/acme-saml",
			asOwner(),
		);
		expect(res.status).toBe(204);
		const listed = await h.call("GET", "/api/sso/providers", asOwner());
		expect(
			listed.json.map((p: { providerId: string }) => p.providerId),
		).toEqual(["acme-idp"]);
	});
});
