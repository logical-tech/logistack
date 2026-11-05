import { describe, expect, test } from "bun:test";
import {
	ApiError,
	DomainInput,
	EnvVarInput,
	EventEnvelope,
	ServiceSpec,
	TemplateApplication,
} from "../src/index.ts";

const app = {
	kind: "application",
	source: {
		type: "git",
		repository: "https://github.com/acme/web",
		branch: "main",
		path: "/",
	},
	build: { type: "dockerfile", dockerfilePath: "Dockerfile", context: "." },
	ports: [{ target: 3000, protocol: "tcp" }],
	replicas: 2,
	resources: { cpu: 0.5, memoryMb: 512 },
	healthcheck: { type: "http", port: 3000, path: "/health" },
	placement: [],
};

describe("ServiceSpec", () => {
	test("accepts each kind", () => {
		expect(ServiceSpec.parse(app).kind).toBe("application");
		expect(
			ServiceSpec.parse({
				kind: "database",
				engine: "postgres",
				version: "17",
				credentialsRef: "var_x",
				resources: {},
			}).kind,
		).toBe("database");
		expect(
			ServiceSpec.parse({
				kind: "compose",
				source: { type: "inline" },
				originalYaml: "services: {}",
				servicesOverrides: { web: { replicas: 3 } },
			}).kind,
		).toBe("compose");
	});

	test("image build requires image source and vice versa", () => {
		expect(
			ServiceSpec.safeParse({ ...app, build: { type: "image" } }).success,
		).toBe(false);
		expect(
			ServiceSpec.safeParse({
				...app,
				source: { type: "image", image: "nginx:1.27" },
			}).success,
		).toBe(false);
		expect(
			ServiceSpec.safeParse({
				...app,
				source: { type: "image", image: "nginx:1.27" },
				build: { type: "image" },
			}).success,
		).toBe(true);
	});

	test("rejects unknown kind and shell-string command", () => {
		expect(ServiceSpec.safeParse({ ...app, kind: "lambda" }).success).toBe(
			false,
		);
		expect(
			ServiceSpec.safeParse({ ...app, command: "npm start" }).success,
		).toBe(false);
	});
});

describe("host-level application fields", () => {
	const image = {
		...app,
		source: { type: "image", image: "itzg/minecraft-server:java25" },
		build: { type: "image" },
	};
	const bind = (hostPath: string, extra = {}) =>
		ServiceSpec.safeParse({
			...image,
			mounts: [{ kind: "bind", hostPath, target: "/data", ...extra }],
		}).success;

	test("accepts the migrated services' shape", () => {
		expect(
			ServiceSpec.safeParse({
				...image,
				ports: [
					{ target: 25565, published: 25565, protocol: "tcp", mode: "host" },
					{ target: 34197, published: 34197, protocol: "udp" },
				],
				mounts: [
					{ kind: "bind", hostPath: "/home/gaming", target: "/folder" },
					{
						kind: "bind",
						hostPath: "/var/lib/filebrowser-quantum",
						target: "/home/filebrowser/data",
						readOnly: false,
					},
				],
				user: "845:845",
				capAdd: ["NET_BIND_SERVICE"],
				capDrop: ["ALL"],
				restart: "any",
			}).success,
		).toBe(true);
	});

	test("bind host paths must be canonical and absolute", () => {
		for (const p of [
			"home/gaming",
			"/home/../etc",
			"/home/./gaming",
			"/home//gaming",
			"/home/gaming/",
			"",
		])
			expect(bind(p)).toBe(false);
	});

	test("sensitive host paths need the admin confirmation", () => {
		for (const p of [
			"/",
			"/etc",
			"/etc/ssl",
			"/proc/1",
			"/sys",
			"/root/.ssh",
			"/var/run/docker.sock",
			"/run/docker.sock",
			"/var",
			"/var/run",
		]) {
			expect(bind(p)).toBe(false);
			expect(bind(p, { allowSensitiveHostPath: true })).toBe(true);
		}
		for (const p of ["/home/gaming", "/var/lib/x", "/etcetera", "/srv"])
			expect(bind(p)).toBe(true);
	});

	test("user is numeric uid[:gid]; capabilities and restart are closed sets", () => {
		expect(ServiceSpec.safeParse({ ...image, user: "845" }).success).toBe(true);
		for (const user of ["root", "845:", ":845", "845:845:1"])
			expect(ServiceSpec.safeParse({ ...image, user }).success).toBe(false);
		expect(
			ServiceSpec.safeParse({ ...image, capAdd: ["CAP_NET_ADMIN"] }).success,
		).toBe(false);
		expect(
			ServiceSpec.safeParse({ ...image, restart: "unless-stopped" }).success,
		).toBe(false);
	});
});

describe("DomainInput", () => {
	const base = {
		hostname: "App.Example.com",
		port: 80,
		https: true,
		cert: "auto",
	};

	test("lowercases hostname and allows wildcards", () => {
		expect(DomainInput.parse(base).hostname).toBe("app.example.com");
		expect(
			DomainInput.safeParse({ ...base, hostname: "*.example.com" }).success,
		).toBe(true);
	});

	test("rejects invalid hostnames", () => {
		for (const hostname of [
			"localhost",
			"-a.example.com",
			"a..b",
			"a b.com",
			"http://x.com",
		]) {
			expect(DomainInput.safeParse({ ...base, hostname }).success).toBe(false);
		}
	});

	test("custom cert iff certificate id", () => {
		expect(DomainInput.safeParse({ ...base, cert: "custom" }).success).toBe(
			false,
		);
		expect(
			DomainInput.safeParse({ ...base, customCertificateId: "crt_1" }).success,
		).toBe(false);
		expect(
			DomainInput.safeParse({
				...base,
				cert: "custom",
				customCertificateId: "crt_1",
			}).success,
		).toBe(true);
	});
});

test("EnvVarInput key format", () => {
	const v = { value: "x", isSecret: false, isBuildTime: false };
	expect(EnvVarInput.safeParse({ ...v, key: "DATABASE_URL" }).success).toBe(
		true,
	);
	expect(EnvVarInput.safeParse({ ...v, key: "1BAD" }).success).toBe(false);
	expect(EnvVarInput.safeParse({ ...v, key: "BAD-KEY" }).success).toBe(false);
});

test("EventEnvelope rejects unknown event types", () => {
	const e = {
		id: "evt_1",
		type: "deployment.succeeded",
		organizationId: "org_1",
		resource: { type: "deployment", id: "dep_1" },
		payload: {},
		at: "2026-11-03T10:00:00.000Z",
	};
	expect(EventEnvelope.parse(e).at).toBeInstanceOf(Date);
	expect(
		EventEnvelope.safeParse({ ...e, type: "deployment.exploded" }).success,
	).toBe(false);
});

test("ApiError shape", () => {
	expect(
		ApiError.safeParse({
			error: { code: "not_found", message: "no such service" },
		}).success,
	).toBe(true);
	expect(
		ApiError.safeParse({ code: "not_found", message: "flat" }).success,
	).toBe(false);
});

test("a template cannot set a LOGISTACK_ variable", () => {
	const parse = (env: Record<string, string>) =>
		TemplateApplication.safeParse({
			name: "web",
			kind: "application",
			image: "nginx:1.27",
			env,
		});
	expect(parse({ PORT: "80" }).success).toBe(true);
	const r = parse({ LOGISTACK_URL: "x" });
	expect(r.success).toBe(false);
	expect(r.error?.issues[0]?.message).toContain("reserved");
});
