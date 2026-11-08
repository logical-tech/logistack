import { createRoute, z } from "@hono/zod-openapi";
import { account, ssoProvider } from "@logistack/db";
import { APIError } from "better-auth";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { resolveRole } from "../access.ts";
import { requireActor } from "../actor.ts";
import { auditInTx, mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import { inOrganization, requirePermission } from "../scope.ts";
import { clearDefaultRole, defaultRoles, setDefaultRole } from "../sso.ts";
import { BlockedHostError, guardedFetch, hostPolicy } from "../ssrf.ts";

const MAX_METADATA = 100_000;

/** Chosen by the wizard up front, so the redirect URI can be registered at the IdP before the provider exists. */
const ProviderId = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{2,62}$/, "lowercase letters, digits and dashes");

const Domain = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/,
		"a domain like company.com",
	);

const Issuer = z.url({ protocol: /^https$/, error: "an https URL" });

const SsoProvider = z
	.object({
		providerId: z.string(),
		type: z.enum(["oidc", "saml"]),
		/** OIDC issuer, or the SAML IdP's entity ID. */
		issuer: z.string(),
		domain: z.string(),
		/** The role a matching sign-in joins with; null when none was chosen. */
		defaultRole: z.string().nullable(),
		/** OIDC only. The secret is never returned. */
		clientIdLastFour: z.string().nullable(),
	})
	.openapi("SsoProvider");

const Discovery = z
	.object({
		issuer: z.string(),
		authorizationEndpoint: z.string(),
		tokenEndpoint: z.string(),
		userInfoEndpoint: z.string().nullable(),
		jwksUri: z.string(),
		scopesSupported: z.array(z.string()),
		tokenEndpointAuthMethods: z.array(z.string()),
	})
	.openapi("OidcDiscovery");

const ServiceProvider = z
	.object({
		/** OIDC: the redirect URI to register at the IdP. */
		redirectUri: z.string(),
		/** SAML: Assertion Consumer Service URL, SP entity ID, SP metadata. */
		acsUrl: z.string(),
		entityId: z.string(),
		metadataUrl: z.string(),
	})
	.openapi("SsoServiceProvider");

const AutoJoin = { domain: Domain, defaultRole: z.string().min(1) };

const OidcInput = z.object({
	providerId: ProviderId,
	issuer: Issuer,
	clientId: z.string().trim().min(1).max(512),
	clientSecret: z.string().min(1).max(4096),
	...AutoJoin,
});

const SamlInput = z
	.object({
		providerId: ProviderId,
		metadataUrl: Issuer.optional(),
		metadataXml: z.string().max(MAX_METADATA).optional(),
		...AutoJoin,
	})
	.refine(
		(v) => (v.metadataUrl === undefined) !== (v.metadataXml === undefined),
		{
			message: "send metadataUrl or metadataXml, not both",
		},
	);

const DiscoveryDocument = z.object({
	issuer: z.string(),
	authorization_endpoint: z.url(),
	token_endpoint: z.url(),
	userinfo_endpoint: z.url().optional(),
	jwks_uri: z.url(),
	scopes_supported: z.array(z.string()).optional(),
	token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

const trimSlash = (url: string) => url.replace(/\/+$/, "");

async function fetchText(c: Context<Env>, url: string, what: string) {
	const res = await guardedFetch(
		url,
		{ signal: AbortSignal.timeout(10_000) },
		await hostPolicy(c.var.deps.db),
	).catch((e: unknown) => {
		if (e instanceof BlockedHostError)
			throw new Failure("bad_request", e.message);
		throw new Failure("bad_request", `couldn't reach ${new URL(url).host}`);
	});
	if (!res.ok)
		throw new Failure(
			"bad_request",
			`${what} at ${url} answered ${res.status}`,
		);
	const text = await res.text();
	if (text.length > MAX_METADATA)
		throw new Failure("bad_request", `${what} is larger than 100 KB`);
	return text;
}

/** The issuer's discovery document, fetched through the SSRF guard. */
async function discover(c: Context<Env>, issuer: string) {
	const url = `${trimSlash(issuer)}/.well-known/openid-configuration`;
	let raw: unknown;
	try {
		raw = JSON.parse(await fetchText(c, url, "the discovery document"));
	} catch (e) {
		if (e instanceof Failure) throw e;
		throw new Failure("bad_request", `${url} is not JSON`);
	}
	const doc = DiscoveryDocument.safeParse(raw);
	if (!doc.success)
		throw new Failure(
			"bad_request",
			"the discovery document lacks required endpoints",
			doc.error.issues,
		);
	if (trimSlash(doc.data.issuer) !== trimSlash(issuer))
		throw new Failure(
			"bad_request",
			`the discovery document names issuer ${doc.data.issuer}, not ${issuer}`,
		);
	return {
		discoveryEndpoint: url,
		issuer: doc.data.issuer,
		authorizationEndpoint: doc.data.authorization_endpoint,
		tokenEndpoint: doc.data.token_endpoint,
		userInfoEndpoint: doc.data.userinfo_endpoint ?? null,
		jwksUri: doc.data.jwks_uri,
		scopesSupported: doc.data.scopes_supported ?? [],
		tokenEndpointAuthMethods:
			doc.data.token_endpoint_auth_methods_supported ?? [],
	};
}

/** The IdP's entity ID and SSO URL; better-auth validates the rest of the XML on register. */
function samlIdp(xml: string) {
	const entityId = xml.match(
		/<(?:[\w-]+:)?EntityDescriptor\b[^>]*\bentityID="([^"]+)"/,
	)?.[1];
	const ssoUrl = xml.match(
		/<(?:[\w-]+:)?SingleSignOnService\b[^>]*\bLocation="([^"]+)"/,
	)?.[1];
	return entityId && ssoUrl ? { entityId, ssoUrl } : null;
}

const authBase = (c: Context<Env>) =>
	`${trimSlash(c.var.deps.config.BETTER_AUTH_URL)}/api/auth`;

function serviceProvider(c: Context<Env>, providerId: string) {
	const base = authBase(c);
	const metadataUrl = `${base}/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`;
	return {
		redirectUri: `${base}/sso/callback/${providerId}`,
		acsUrl: `${base}/sso/saml2/sp/acs/${providerId}`,
		entityId: metadataUrl,
		metadataUrl,
	};
}

async function validateAutoJoin(c: Context<Env>, role: string) {
	// Joining as owner would hand the organization to whoever the IdP vouches for.
	if (role === "owner")
		throw new Failure("bad_request", "SSO sign-ins cannot join as owner");
	await resolveRole(c, role);
}

/**
 * Registers through better-auth (its validation, its storage), then binds the provider to the
 * organization here: better-auth's own org check knows only its owner/admin role names.
 */
async function register(
	c: Context<Env>,
	input: { providerId: string; domain: string; defaultRole: string },
	config: Record<string, unknown>,
) {
	const actor = requireActor(c);
	if (actor.kind !== "user")
		throw new Failure(
			"bad_request",
			"SSO providers are registered from a signed-in session, not an API key",
		);
	const { db, auth } = c.var.deps;
	c.set("auditResourceId", input.providerId);
	try {
		await auth.api.registerSSOProvider({
			headers: c.req.raw.headers,
			body: { providerId: input.providerId, domain: input.domain, ...config },
		});
	} catch (e) {
		if (e instanceof APIError)
			throw new Failure(
				e.statusCode === 422 ? "conflict" : "bad_request",
				e.body?.message ?? e.message,
			);
		throw e;
	}
	try {
		await db
			.update(ssoProvider)
			.set({ organizationId: actor.organizationId })
			.where(eq(ssoProvider.providerId, input.providerId));
		await setDefaultRole(
			db,
			actor.organizationId,
			input.providerId,
			input.defaultRole,
		);
	} catch (e) {
		await db
			.delete(ssoProvider)
			.where(eq(ssoProvider.providerId, input.providerId));
		throw e;
	}
	const [created] = await listProviders(c, input.providerId);
	if (!created) throw notFound("sso provider");
	return created;
}

async function listProviders(c: Context<Env>, providerId?: string) {
	const { db } = c.var.deps;
	const orgId = requireActor(c).organizationId;
	const [rows, roles] = await Promise.all([
		db
			.select()
			.from(ssoProvider)
			.where(
				and(
					eq(ssoProvider.organizationId, orgId),
					providerId ? eq(ssoProvider.providerId, providerId) : undefined,
				),
			)
			.orderBy(ssoProvider.providerId),
		defaultRoles(db, orgId),
	]);
	return rows.map((p) => {
		const oidc = p.oidcConfig ? JSON.parse(p.oidcConfig) : null;
		const saml = p.samlConfig ? JSON.parse(p.samlConfig) : null;
		const clientId: string | undefined = oidc?.clientId;
		return {
			providerId: p.providerId,
			type: saml ? ("saml" as const) : ("oidc" as const),
			issuer: saml
				? (samlIdp(saml.idpMetadata?.metadata ?? "")?.entityId ?? p.issuer)
				: p.issuer,
			domain: p.domain,
			defaultRole: roles[p.providerId] ?? null,
			clientIdLastFour: clientId ? clientId.slice(-4) : null,
		};
	});
}

const admin = requirePermission("admin", inOrganization);

export const sso = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/sso/status",
			tags: ["sso"],
			summary: "Whether any SSO provider exists (public, for the sign-in page)",
			responses: {
				200: json(z.object({ enabled: z.boolean() }), "SSO status"),
			},
		}),
		async (c) =>
			c.json({ enabled: (await c.var.deps.db.$count(ssoProvider)) > 0 }, 200),
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/sso/providers",
			tags: ["sso"],
			security,
			summary: "SSO providers of the organization",
			middleware: [admin],
			responses: { 200: json(z.array(SsoProvider), "Providers"), ...errors },
		}),
		async (c) => c.json(await listProviders(c), 200),
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/sso/discovery",
			tags: ["sso"],
			security,
			summary: "Fetch an OIDC issuer's discovery document",
			middleware: [admin],
			request: { query: z.object({ issuer: Issuer }) },
			responses: { 200: json(Discovery, "Discovered endpoints"), ...errors },
		}),
		async (c) => {
			const { discoveryEndpoint: _, ...found } = await discover(
				c,
				c.req.valid("query").issuer,
			);
			return c.json(found, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/sso/service-provider",
			tags: ["sso"],
			security,
			summary: "The URLs to register at the IdP for a provider id",
			middleware: [admin],
			request: { query: z.object({ providerId: ProviderId }) },
			responses: {
				200: json(ServiceProvider, "Service provider URLs"),
				...errors,
			},
		}),
		async (c) =>
			c.json(serviceProvider(c, c.req.valid("query").providerId), 200),
	)
	.openapi(
		mutation(
			"sso_provider.create",
			createRoute({
				method: "post",
				path: "/sso/providers/oidc",
				tags: ["sso"],
				security,
				summary: "Register an OIDC provider",
				description:
					"Endpoints come from the issuer's discovery document. The client secret is stored and never returned. Users whose email domain is `domain` join the organization as `defaultRole` on sign-in.",
				middleware: [admin],
				request: body(OidcInput),
				responses: { 201: json(SsoProvider, "Registered"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			await validateAutoJoin(c, input.defaultRole);
			const found = await discover(c, input.issuer);
			const methods = found.tokenEndpointAuthMethods;
			const created = await register(c, input, {
				issuer: found.issuer,
				oidcConfig: {
					clientId: input.clientId,
					clientSecret: input.clientSecret,
					// Discovered here through the SSRF guard; better-auth's own discovery is unguarded.
					skipDiscovery: true,
					discoveryEndpoint: found.discoveryEndpoint,
					authorizationEndpoint: found.authorizationEndpoint,
					tokenEndpoint: found.tokenEndpoint,
					userInfoEndpoint: found.userInfoEndpoint ?? undefined,
					jwksEndpoint: found.jwksUri,
					tokenEndpointAuthentication:
						methods.length === 0 || methods.includes("client_secret_basic")
							? "client_secret_basic"
							: "client_secret_post",
					scopes: ["openid", "email", "profile"],
					pkce: true,
				},
			});
			return c.json(created, 201);
		},
	)
	.openapi(
		mutation(
			"sso_provider.create",
			createRoute({
				method: "post",
				path: "/sso/providers/saml",
				tags: ["sso"],
				security,
				summary: "Register a SAML provider",
				description:
					"IdP metadata comes from `metadataUrl` (fetched server-side) or `metadataXml`. Users whose email domain is `domain` join the organization as `defaultRole` on sign-in.",
				middleware: [admin],
				request: body(SamlInput),
				responses: { 201: json(SsoProvider, "Registered"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			await validateAutoJoin(c, input.defaultRole);
			const xml =
				input.metadataXml ??
				(await fetchText(c, input.metadataUrl ?? "", "the IdP metadata"));
			const idp = samlIdp(xml);
			if (!idp)
				throw new Failure(
					"bad_request",
					"the metadata has no entityID or SingleSignOnService location",
				);
			const sp = serviceProvider(c, input.providerId);
			const created = await register(c, input, {
				issuer: sp.entityId,
				samlConfig: {
					entryPoint: idp.ssoUrl,
					idpMetadata: { metadata: xml },
					spMetadata: {},
				},
			});
			return c.json(created, 201);
		},
	)
	.openapi(
		mutation(
			"sso_provider.delete",
			createRoute({
				method: "delete",
				path: "/sso/providers/{providerId}",
				tags: ["sso"],
				security,
				summary: "Delete an SSO provider",
				description:
					"Its linked sign-in accounts go too; members it brought in stay.",
				middleware: [admin],
				request: { params: z.object({ providerId: z.string() }) },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { providerId } = c.req.valid("param");
			c.set("auditResourceId", providerId);
			const orgId = requireActor(c).organizationId;
			const { db } = c.var.deps;
			const removed = await db.transaction(async (tx) => {
				const rows = await tx
					.delete(ssoProvider)
					.where(
						and(
							eq(ssoProvider.providerId, providerId),
							eq(ssoProvider.organizationId, orgId),
						),
					)
					.returning({ id: ssoProvider.id });
				if (rows.length > 0)
					await tx.delete(account).where(eq(account.providerId, providerId));
				if (rows.length > 0) await auditInTx(c, tx);
				return rows.length > 0;
			});
			if (!removed) throw notFound("sso provider");
			await clearDefaultRole(db, orgId, providerId);
			return c.body(null, 204);
		},
	);
