import { describe, expect, test } from "bun:test";
import { ManifestEnvironment } from "@logistack/contracts";
import { deploymentContextEnv } from "../src/deployment-context.ts";
import {
	previewEnvironment,
	previewHostname,
	previewUrls,
} from "../src/preview.ts";

const app = (slug: string, domains: unknown[]) => ({
	name: slug,
	slug,
	spec: {
		kind: "application",
		source: {
			type: "git",
			repository: "acme/shop",
			branch: "main",
			path: ".",
		},
		build: { type: "dockerfile", dockerfilePath: "Dockerfile", context: "." },
		ports: [],
		replicas: 1,
		resources: {},
		placement: [],
	},
	gitProvider: "GitHub",
	variables: [
		{ key: "API_URL", value: "https://api.example.com", buildTime: true },
		{ key: "LOG_LEVEL", value: "info" },
	],
	mounts: [{ kind: "volume", target: "/data", name: "uploads" }],
	domains,
});

const source = ManifestEnvironment.parse({
	name: "Production",
	slug: "production",
	kind: "production",
	color: "blue",
	variables: [{ key: "STRIPE_KEY", value: "sk_live", secret: true }],
	services: [
		app("web", [
			{ hostname: "shop.example.com", port: 3000, https: true, cert: "auto" },
		]),
		app("api", [
			{
				hostname: "old.example.com",
				port: 80,
				https: true,
				cert: "auto",
				redirectTo: "shop.example.com",
			},
			{ hostname: "api.example.com", port: 8080, https: true, cert: "auto" },
		]),
		{
			name: "db",
			slug: "db",
			spec: {
				kind: "database",
				engine: "postgres",
				version: "17",
				credentialsRef: "env",
				resources: {},
			},
			variables: [{ key: "POSTGRES_PASSWORD", value: "pw", secret: true }],
			backups: [
				{
					target: "database",
					destination: "s3",
					cron: "0 3 * * *",
					retention: { count: 7 },
				},
			],
		},
	],
});

const input = {
	number: 42,
	headBranch: "feature/cart",
	follow: ["web"],
	variables: [
		{ key: "STRIPE_KEY", value: "sk_test", secret: true },
		{ key: "API_URL", value: "https://pr-42-api.preview.dev", secret: false },
	],
	domainPattern: "pr-{number}-{service}.{wildcard}",
	wildcard: "preview.dev",
};

describe("previewHostname", () => {
	test("fills the tokens", () => {
		expect(
			previewHostname("pr-{number}.{wildcard}", {
				number: 7,
				service: "web",
				wildcard: "apps.example.com",
			}),
		).toBe("pr-7.apps.example.com");
	});
	test("null without a wildcard to fill, or when the result is no hostname", () => {
		expect(
			previewHostname("pr-{number}.{wildcard}", { number: 7, service: "web" }),
		).toBeNull();
		expect(
			previewHostname("pr {number}.example.com", { number: 7, service: "w" }),
		).toBeNull();
	});
});

describe("previewEnvironment", () => {
	const { environment, generated } = previewEnvironment(source, input);
	const svc = (slug: string) =>
		environment.services.find((s) => s.slug === slug);

	test("is the pull request's own preview environment", () => {
		expect(environment).toMatchObject({
			name: "PR #42",
			slug: "pr-42",
			kind: "preview",
		});
		expect(environment.color).toBeUndefined();
	});

	test("only the followed services build the pull request's branch", () => {
		const branch = (slug: string) => {
			const spec = svc(slug)?.spec;
			return spec && "source" in spec && spec.source.type === "git"
				? spec.source.branch
				: undefined;
		};
		expect(branch("web")).toBe("feature/cart");
		expect(branch("api")).toBe("main");
		const original = source.services[0]?.spec;
		expect(
			original && "source" in original && original.source.type === "git"
				? original.source.branch
				: undefined,
		).toBe("main");
	});

	test("overrides replace every source definition of their key", () => {
		expect(environment.variables).toEqual([
			{ key: "STRIPE_KEY", value: "sk_test", secret: true, buildTime: false },
			{
				key: "API_URL",
				value: "https://pr-42-api.preview.dev",
				secret: false,
				buildTime: true,
			},
		]);
		expect(svc("web")?.variables.map((v) => v.key)).toEqual(["LOG_LEVEL"]);
	});

	test("one domain per exposed service, from the pattern; redirects are not exposure", () => {
		expect(svc("web")?.domains).toEqual([
			{
				hostname: "pr-42-web.preview.dev",
				port: 3000,
				https: true,
				cert: "auto",
				tunnel: false,
			},
		]);
		expect(svc("api")?.domains.map((d) => [d.hostname, d.port])).toEqual([
			["pr-42-api.preview.dev", 8080],
		]);
		expect(svc("db")?.domains).toEqual([]);
		expect(generated).toEqual([]);
	});

	test("no backups; mounts and database variables come along so the app still connects", () => {
		expect(svc("db")?.backups).toEqual([]);
		expect(svc("db")?.variables).toEqual(source.services[2]?.variables ?? []);
		expect(svc("web")?.mounts).toEqual(source.services[0]?.mounts ?? []);
	});

	test("a host another service took, or no pattern, falls back to a generated one", () => {
		const shared = previewEnvironment(source, {
			...input,
			domainPattern: "pr-{number}.{wildcard}",
		});
		expect(
			shared.environment.services.flatMap((s) =>
				s.domains.map((d) => d.hostname),
			),
		).toEqual(["pr-42.preview.dev"]);
		expect(shared.generated).toEqual([{ service: "api", port: 8080 }]);
		expect(
			previewEnvironment(source, { ...input, domainPattern: null }).generated,
		).toEqual([
			{ service: "web", port: 3000 },
			{ service: "api", port: 8080 },
		]);
	});

	test("the result is a valid environment manifest", () => {
		expect(ManifestEnvironment.safeParse(environment).success).toBe(true);
	});
});

describe("previewUrls", () => {
	const services = [
		{
			slug: "web",
			domains: [
				{ hostname: "web-abc123.sslip.io", isGenerated: true },
				{ hostname: "pr-7-web.preview.dev", isGenerated: false },
			],
		},
		{
			slug: "api",
			domains: [
				{ hostname: "old.preview.dev", redirectTo: "pr-7-api.preview.dev" },
				{ hostname: "pr-7-api.preview.dev", pathPrefix: "/v1" },
			],
		},
		{ slug: "db", domains: [] },
	];

	test("each exposed service's first serving URL, a custom host before a generated one", () => {
		expect(previewUrls(services, []).serviceUrls).toEqual({
			api: "https://pr-7-api.preview.dev/v1",
			web: "https://pr-7-web.preview.dev",
		});
	});

	test("the main URL is the first followed service's, else the first URL", () => {
		expect(previewUrls(services, ["db", "web"]).primaryUrl).toBe(
			"https://pr-7-web.preview.dev",
		);
		expect(previewUrls(services, []).primaryUrl).toBe(
			"https://old.preview.dev",
		);
		expect(previewUrls([], ["web"])).toEqual({ urls: [], serviceUrls: {} });
	});
});

describe("preview URL variables", () => {
	const base = {
		deploymentId: "dep_1",
		environment: "PR #7",
		project: "Shop",
		service: "web",
		domains: [],
	};

	test("every service's URL, by slug in upper case, and the main one", () => {
		const env = deploymentContextEnv({
			...base,
			preview: {
				primaryUrl: "https://pr-7-web.preview.dev",
				serviceUrls: {
					web: "https://pr-7-web.preview.dev",
					"api-v2": "https://pr-7-api-v2.preview.dev",
				},
			},
		});
		expect(env.LOGISTACK_PREVIEW_URL).toBe("https://pr-7-web.preview.dev");
		expect(env.LOGISTACK_PREVIEW_URL_WEB).toBe("https://pr-7-web.preview.dev");
		expect(env.LOGISTACK_PREVIEW_URL_API_V2).toBe(
			"https://pr-7-api-v2.preview.dev",
		);
	});

	test("outside a preview none is set", () => {
		expect(
			Object.keys(deploymentContextEnv(base)).filter((k) =>
				k.startsWith("LOGISTACK_PREVIEW"),
			),
		).toEqual([]);
	});
});
