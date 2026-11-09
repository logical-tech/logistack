import { z } from "zod";
import { IpRange } from "./access.ts";

/** Requests per second per client IP, with a burst on top; exempt ranges skip the limit. Above it the proxy answers 429. */
export const RateLimit = z
	.object({
		requestsPerSecond: z.int().min(1).max(10_000),
		burst: z.int().min(1).max(100_000),
		exemptCidrs: z.array(IpRange).max(100).default([]),
	})
	.refine((r) => r.burst >= r.requestsPerSecond, {
		message: "burst must be at least the requests per second",
		path: ["burst"],
	});
export type RateLimit = z.infer<typeof RateLimit>;

/** A path glob as Caddy's path matcher takes it: `*` matches anything, case-insensitive. */
const BlockedPath = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.regex(/^\/[^\s{}]*$/, "a path starting with /, such as /wp-admin*");

const UserAgentFragment = z.string().trim().min(2).max(128);

/** Requests matching any path or containing any user-agent fragment get 403. */
export const BlockRules = z.object({
	paths: z.array(BlockedPath).max(100).default([]),
	userAgents: z.array(UserAgentFragment).max(100).default([]),
});
export type BlockRules = z.infer<typeof BlockRules>;

/** An HTML page of at most 64 KB shown instead of a blank 502, 503 or 504 from the proxy. */
export const ErrorPageHtml = z.string().min(1).max(65_536);

/** What the proxy does at the edge of one domain, before access rules and the upstream. */
export const DomainEdge = z.object({
	rateLimit: RateLimit.nullable().default(null),
	block: BlockRules.nullable().default(null),
	/** Null shows the organization's branded page. */
	errorPage: ErrorPageHtml.nullable().default(null),
});
export type DomainEdge = z.infer<typeof DomainEdge>;

export const emptyDomainEdge: DomainEdge = {
	rateLimit: null,
	block: null,
	errorPage: null,
};

/** While enabled, every domain of the service answers 503 with a branded page; allowed IPs reach the service. */
export const ServiceMaintenance = z.object({
	enabled: z.boolean(),
	allowCidrs: z.array(IpRange).max(100).default([]),
	message: z.string().trim().max(500).nullable().default(null),
});
export type ServiceMaintenance = z.infer<typeof ServiceMaintenance>;
