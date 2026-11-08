import { describe, expect, test } from "bun:test";
import { PluginManifest } from "@logistack/contracts";
import {
	compilePlugin,
	maskConfig,
	memoryMb,
	mergeConfig,
	pluginBaseUrl,
	pluginServiceName,
	SECRET_MASK,
} from "../src/plugin.ts";

const manifest = PluginManifest.parse({
	id: "com.acme.notifier",
	version: "1.0.0",
	name: "Notifier",
	resources: { memory: "4Gi", cpu: 2 },
	config: {
		type: "object",
		properties: {
			url: { type: "string" },
			token: { type: "string", secret: true },
		},
	},
});

const install = {
	id: "plg_0123456789abcdefghjkmnpq",
	organizationId: "org_1",
	image: "ghcr.io/acme/notifier@sha256:abc",
	enabled: true,
	manifest,
};

const env = {
	LOGISTACK_URL: "http://logistack_logistack-api:3000",
	LOGISTACK_TOKEN: "lsk_x",
	LOGISTACK_SIGNING_SECRET: "s".repeat(32),
};

describe("compilePlugin", () => {
	test("snapshot", () => {
		expect(compilePlugin({ install, env, network: "net1" })).toMatchSnapshot();
	});

	test("hardened: read-only root, every capability dropped, no host mounts, capped limits", () => {
		const spec = compilePlugin({ install, env, network: "net1" });
		const c = spec.TaskTemplate.ContainerSpec;
		expect(c?.ReadOnly).toBe(true);
		expect(c?.CapabilityDrop).toEqual(["ALL"]);
		expect(c?.Mounts?.some((m) => m.Type === "bind")).toBe(false);
		expect(spec.TaskTemplate.Resources?.Limits?.MemoryBytes).toBe(
			1024 * 1024 * 1024,
		);
		expect(spec.TaskTemplate.Resources?.Limits?.NanoCPUs).toBe(1e9);
		expect(spec.Labels?.["logistack.managed"]).toBe("true");
		expect(spec.Labels?.["logistack.kind"]).toBe("plugin");
		expect(spec.Name).toBe("ls-plg-0123456789abcdefghjkmnpq");
	});

	test("a disabled install keeps its service at zero replicas", () => {
		const spec = compilePlugin({
			install: { ...install, enabled: false },
			env,
			network: "net1",
		});
		expect(spec.Mode?.Replicated?.Replicas).toBe(0);
	});

	test("the test scope prefixes names", () => {
		const spec = compilePlugin({
			install,
			env,
			network: "n",
			scope: {
				namePrefix: "ls-test-plugins-",
				labels: { "logistack.test": "plugins" },
			},
		});
		expect(spec.Name.startsWith("ls-test-plugins-ls-plg-")).toBe(true);
		expect(spec.Labels?.["logistack.test"]).toBe("plugins");
	});
});

describe("helpers", () => {
	test("memoryMb", () => {
		expect(memoryMb("128Mi")).toBe(128);
		expect(memoryMb("2Gi")).toBe(2048);
		expect(() => memoryMb("1G")).toThrow();
	});

	test("base URL is the dev URL or the service on the plugins network", () => {
		expect(pluginBaseUrl({ ...install, devUrl: "https://x.dev/" })).toBe(
			"https://x.dev",
		);
		expect(pluginBaseUrl({ ...install, devUrl: null })).toBe(
			`http://${pluginServiceName(install.id)}:8080`,
		);
	});

	test("secrets are masked on read and kept when the mask comes back", () => {
		const stored = { url: "https://a", token: "t0p" };
		const masked = maskConfig(stored, manifest.config);
		expect(masked).toEqual({ url: "https://a", token: SECRET_MASK });
		expect(
			mergeConfig(stored, { ...masked, url: "https://b" }, manifest.config),
		).toEqual({
			url: "https://b",
			token: "t0p",
		});
	});
});
