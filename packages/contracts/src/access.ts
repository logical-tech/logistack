import { z } from "zod";

/** An address or a CIDR range, IPv4 or IPv6, as Caddy's IP matchers take it. */
export const IpRange = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

const HeaderName = z
	.string()
	.max(64)
	.regex(/^[A-Za-z0-9-]+$/, "a header name such as Remote-User");

const IpAllow = z.object({
	type: z.literal("ip_allow"),
	cidrs: z.array(IpRange).min(1).max(100),
	/** Proxies whose X-Forwarded-For is believed. Without them only the connection's address counts. */
	trustedProxies: z.array(IpRange).max(20).optional(),
});

const ForwardAuth = z.object({
	type: z.literal("forward_auth"),
	/** Asked with GET for every request; a 2xx lets it through, anything else is returned to the client. */
	url: z.url({ protocol: /^https?$/ }).max(2048),
	/** Headers of a 2xx auth response copied onto the request to the upstream. */
	copyHeaders: z.array(HeaderName).max(20),
});

export const BasicAuthUsername = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[^:\s]+$/, "no colons or spaces");

/** A user without a password keeps the hash it already has. */
export const BasicAuthUserInput = z.object({
	username: BasicAuthUsername,
	password: z.string().min(8).max(128).optional(),
});
export type BasicAuthUserInput = z.infer<typeof BasicAuthUserInput>;

export const uniqueUsernames = (users: { username: string }[]) =>
	new Set(users.map((u) => u.username)).size === users.length;

const basicAuth = <U extends z.ZodType<{ username: string }>>(user: U) =>
	z.object({
		type: z.literal("basic_auth"),
		users: z
			.array(user)
			.min(1)
			.max(20)
			.refine(uniqueUsernames, "usernames must be unique"),
	});

const oneOfEach = (rules: { type: string }[]) =>
	new Set(rules.map((r) => r.type)).size === rules.length;

/** Stored form: basic auth keeps bcrypt hashes only. */
export const AccessRule = z.discriminatedUnion("type", [
	IpAllow,
	ForwardAuth,
	basicAuth(z.object({ username: z.string(), hash: z.string() })),
]);
export type AccessRule = z.infer<typeof AccessRule>;

export const AccessRuleInput = z.discriminatedUnion("type", [
	IpAllow,
	ForwardAuth,
	basicAuth(BasicAuthUserInput),
]);
export type AccessRuleInput = z.infer<typeof AccessRuleInput>;

/** What the API returns: usernames, never hashes. */
export const AccessRuleView = z.discriminatedUnion("type", [
	IpAllow,
	ForwardAuth,
	basicAuth(z.object({ username: z.string() })),
]);
export type AccessRuleView = z.infer<typeof AccessRuleView>;

export const AccessRulesInput = z
	.array(AccessRuleInput)
	.max(3)
	.refine(oneOfEach, "at most one rule of each type");
