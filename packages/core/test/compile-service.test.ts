import { describe, expect, test } from "bun:test";
import {
	type DatabaseEngine,
	deploymentContextVars,
} from "@logistack/contracts";
import {
	type CompileServiceInput,
	compileService,
	serviceFiles,
} from "../src/compile-service.ts";
import { databaseCredentials } from "../src/database-credentials.ts";

const app: CompileServiceInput = {
	service: {
		id: "svc_app0000000000000000000000",
		organizationId: "org_acme",
		environmentId: "env_prod00000000000000000000",
		slug: "web",
		desiredState: "running",
		spec: {
			kind: "application",
			source: { type: "image", image: "nginx:1.27" },
			build: { type: "image" },
			ports: [
				{ target: 8080, published: 18080, protocol: "tcp", mode: "ingress" },
			],
			replicas: 2,
			resources: { cpu: 0.5, memoryMb: 256 },
			command: ["serve", "--port", "8080"],
			placement: ["node.labels.region==eu"],
		},
	},
	deploymentId: "dep_one0000000000000000000000",
	image: "registry.example.com/org_acme/ls-svc-app:dep_one",
	env: { PORT: "8080", API_KEY: "s3cret" },
	context: {
		project: "Shop",
		environment: "production",
		service: "Web",
		domains: [],
	},
	mounts: [],
	domains: [],
	networks: { environment: "net-env-id", ingress: "net-ingress-id" },
	fileIds: {},
};

const withFiles = (input: CompileServiceInput): CompileServiceInput => ({
	...input,
	fileIds: Object.fromEntries(
		serviceFiles(input).map((f) => [f.name, `id-of-${f.name}`]),
	),
});

const stateful: CompileServiceInput = withFiles({
	...app,
	mounts: [
		{
			id: "mnt_data000000000000000000000",
			kind: "volume",
			target: "/data",
			readOnly: false,
		},
		{
			id: "mnt_conf000000000000000000000",
			kind: "config",
			target: "/etc/app/config.toml",
			readOnly: true,
			content: "level = 'info'\n",
		},
		{
			id: "mnt_key0000000000000000000000",
			kind: "secret",
			target: "/run/secrets/key",
			readOnly: true,
			content: "hunter2",
		},
	],
	domains: [{ port: 8080 }],
	pinNodeId: "node-abc",
});

const dbEnv: Record<DatabaseEngine, Record<string, string>> = {
	postgres: { POSTGRES_PASSWORD: "pw", POSTGRES_USER: "app" },
	mysql: { MYSQL_ROOT_PASSWORD: "pw" },
	mariadb: { MARIADB_ROOT_PASSWORD: "pw" },
	mongo: {
		MONGO_INITDB_ROOT_USERNAME: "root",
		MONGO_INITDB_ROOT_PASSWORD: "pw",
	},
	redis: { REDIS_PASSWORD: "pw" },
	libsql: { SQLD_AUTH_JWT_KEY: "key", LIBSQL_AUTH_TOKEN: "token" },
};

const database = (engine: DatabaseEngine): CompileServiceInput => ({
	...app,
	service: {
		...app.service,
		id: "svc_db00000000000000000000000",
		slug: "db",
		spec: {
			kind: "database",
			engine,
			version: "1",
			credentialsRef: "ref",
			resources: {},
		},
	},
	image: undefined,
	env: dbEnv[engine],
	domains: [{ port: 5432 }],
	pinNodeId: "node-abc",
});

describe("snapshots", () => {
	test("stateless application", () => {
		expect(compileService(app)).toMatchSnapshot();
	});
	test("stateful application with domain, config and secret", () => {
		expect(compileService(stateful)).toMatchSnapshot();
	});
	for (const engine of Object.keys(dbEnv) as DatabaseEngine[]) {
		test(`database ${engine}`, () => {
			expect(compileService(database(engine))).toMatchSnapshot();
		});
	}
});

describe("deployment context", () => {
	const domain = {
		https: true,
		tunnel: false,
		pathPrefix: null,
		redirectTo: null,
		isGenerated: false,
	};
	const gitApp: CompileServiceInput = {
		...app,
		service: {
			...app.service,
			spec: {
				...app.service.spec,
				source: {
					type: "git",
					repository: "https://github.com/acme/shop.git",
					branch: "main",
					path: ".",
				},
				build: {
					type: "dockerfile",
					dockerfilePath: "Dockerfile",
					context: ".",
				},
			} as CompileServiceInput["service"]["spec"],
		},
		context: {
			...app.context,
			commit: {
				sha: "0123456789abcdef0123456789abcdef01234567",
				message: "fix: checkout total\n\nLong body that must not leak.",
				branch: "main",
			},
			domains: [
				{ ...domain, hostname: "web-1-2-3-4.sslip.io", isGenerated: true },
				{ ...domain, hostname: "*.preview.acme.dev" },
				{ ...domain, hostname: "old.acme.dev", redirectTo: "shop.acme.dev" },
				{ ...domain, hostname: "shop.acme.dev", pathPrefix: "/app" },
				{ ...domain, hostname: "shop.acme.dev", pathPrefix: "/api" },
			],
		},
	};
	const env = (i: CompileServiceInput) =>
		Object.fromEntries(
			(compileService(i).TaskTemplate.ContainerSpec.Env ?? []).map((e) => {
				const at = e.indexOf("=");
				return [e.slice(0, at), e.slice(at + 1)];
			}),
		);

	test("image source without domains", () => {
		expect(env(app)).toMatchSnapshot();
	});

	test("git source with domains", () => {
		expect(env(gitApp)).toMatchSnapshot();
	});

	test("image-only services get every variable except the commit ones", () => {
		const vars = env({
			...gitApp,
			context: { ...gitApp.context, commit: undefined },
		});
		const injected = Object.keys(vars).filter((k) =>
			k.startsWith("LOGISTACK_"),
		);
		expect(injected.sort()).toEqual(
			Object.keys(deploymentContextVars)
				.filter((k) => !/COMMIT|BRANCH/.test(k))
				.sort(),
		);
	});

	test("the primary domain is the first custom one; a tunnel is served over https", () => {
		const url = (domains: CompileServiceInput["context"]["domains"]) =>
			env({ ...app, context: { ...app.context, domains } }).LOGISTACK_URL;
		expect(
			url([{ ...domain, hostname: "a.sslip.io", isGenerated: true }]),
		).toBe("https://a.sslip.io");
		expect(url([{ ...domain, hostname: "a.dev", https: false }])).toBe(
			"http://a.dev",
		);
		expect(
			url([{ ...domain, hostname: "a.dev", https: false, tunnel: true }]),
		).toBe("https://a.dev");
		expect(url([{ ...domain, hostname: "*.a.dev" }])).toBeUndefined();
	});

	test("a long commit message is cut to its first 200 characters", () => {
		const vars = env({
			...gitApp,
			context: {
				...gitApp.context,
				commit: { sha: "abc", message: "x".repeat(300), branch: "main" },
			},
		});
		expect(vars.LOGISTACK_COMMIT_MESSAGE).toBe("x".repeat(200));
	});

	test("a stored variable with a reserved name never shadows the injected one", () => {
		expect(
			env({ ...app, env: { LOGISTACK_DEPLOYMENT_ID: "spoofed" } })
				.LOGISTACK_DEPLOYMENT_ID,
		).toBe(app.deploymentId);
	});
});

describe("networks", () => {
	const targets = (i: CompileServiceInput) =>
		compileService(i).TaskTemplate.Networks?.map((n) => n.Target);

	test("ingress only when the service has a domain", () => {
		expect(targets(app)).toEqual(["net-env-id"]);
		expect(targets({ ...app, domains: [{ port: 8080 }] })).toEqual([
			"net-env-id",
			"net-ingress-id",
		]);
	});

	test("databases never join ingress, even with a domain row", () => {
		for (const engine of Object.keys(dbEnv) as DatabaseEngine[])
			expect(targets(database(engine))).toEqual(["net-env-id"]);
	});

	test("databases join the db network without an alias; apps never do", () => {
		const withDb = (i: CompileServiceInput) => ({
			...i,
			networks: { ...i.networks, db: "net-db-id" },
		});
		for (const engine of Object.keys(dbEnv) as DatabaseEngine[])
			expect(
				compileService(withDb(database(engine))).TaskTemplate.Networks,
			).toEqual([
				{ Target: "net-env-id", Aliases: ["db"] },
				{ Target: "net-db-id" },
			]);
		expect(targets(withDb({ ...app, domains: [{ port: 8080 }] }))).toEqual([
			"net-env-id",
			"net-ingress-id",
		]);
	});

	test("the slug is the only alias, and only on the environment network", () => {
		const nets = compileService({ ...app, domains: [{ port: 8080 }] })
			.TaskTemplate.Networks;
		expect(nets).toEqual([
			{ Target: "net-env-id", Aliases: ["web"] },
			{ Target: "net-ingress-id" },
		]);
	});

	test("a slug that is not a DNS label refuses to compile", () => {
		for (const slug of ["Web", "web_1", "-web", "a".repeat(64)])
			expect(() =>
				compileService({ ...app, service: { ...app.service, slug } }),
			).toThrow("is not a DNS label");
	});
});

test("entrypoint replaces the image entrypoint, command stays the args", () => {
	const spec = compileService({
		...app,
		service: {
			...app.service,
			spec: { ...app.service.spec, entrypoint: ["/bin/sh", "-c"] },
		} as CompileServiceInput["service"],
	}).TaskTemplate.ContainerSpec;
	expect(spec.Command).toEqual(["/bin/sh", "-c"]);
	expect(spec.Args).toEqual(["serve", "--port", "8080"]);
});

describe("configs and secrets", () => {
	const configName = (i: CompileServiceInput) =>
		compileService(i).TaskTemplate.ContainerSpec.Configs?.[0]?.ConfigName;

	test("a content change changes the object name, the same content keeps it", () => {
		const changed = withFiles({
			...stateful,
			mounts: stateful.mounts.map((m) =>
				m.kind === "config" ? { ...m, content: "level = 'debug'\n" } : m,
			),
		});
		expect(configName(changed)).not.toBe(configName(stateful));
		expect(configName(withFiles(stateful))).toBe(configName(stateful));
		expect(configName(stateful)).toMatch(/^ls-cfg-conf0+-[0-9a-f]{12}$/);
	});

	test("missing Swarm id is a compile error", () => {
		expect(() => compileService({ ...stateful, fileIds: {} })).toThrow(
			/has no Swarm id/,
		);
	});
});

describe("placement and rollout", () => {
	test("stateful services are pinned and stop first", () => {
		const spec = compileService(stateful);
		expect(spec.TaskTemplate.Placement?.Constraints).toContain(
			"node.id==node-abc",
		);
		expect(spec.UpdateConfig?.Order).toBe("stop-first");
		expect(() => compileService({ ...stateful, pinNodeId: undefined })).toThrow(
			/needs a node to pin/,
		);
	});

	test("stateless services are not pinned and start first with rollback", () => {
		const spec = compileService(app);
		expect(spec.TaskTemplate.Placement?.Constraints).toEqual([
			"node.labels.region==eu",
		]);
		expect(spec.UpdateConfig).toMatchObject({
			Order: "start-first",
			FailureAction: "rollback",
		});
	});

	test("desired state stopped scales to zero", () => {
		const spec = compileService({
			...app,
			service: { ...app.service, desiredState: "stopped" },
		});
		expect(spec.Mode).toEqual({ Replicated: { Replicas: 0 } });
	});

	test("every deployment changes the task spec", () => {
		const a = compileService(app).TaskTemplate;
		const b = compileService({ ...app, deploymentId: "dep_two" }).TaskTemplate;
		expect(a).not.toEqual(b);
	});
});

describe("healthcheck", () => {
	const test_ = (i: CompileServiceInput) =>
		compileService(i).TaskTemplate.ContainerSpec.Healthcheck?.Test;

	test("none without a domain or a user check", () => {
		expect(test_(app)).toBeUndefined();
	});

	test("default TCP check on the first port when a domain exists", () => {
		expect(test_({ ...app, domains: [{ port: 9999 }] })).toEqual([
			"CMD-SHELL",
			"grep -sqE ':1F90 [0-9A-F]{8,32}:0000 0A' /proc/net/tcp /proc/net/tcp6",
		]);
	});

	test("user HTTP check is shell-quoted", () => {
		const spec = {
			...app.service.spec,
			healthcheck: { type: "http" as const, port: 80, path: "/h'x" },
		};
		const t = test_({ ...app, service: { ...app.service, spec } });
		expect(t?.[1]).toContain(`'http://127.0.0.1:80/h'"'"'x'`);
	});

	test("user command check is argv", () => {
		const spec = {
			...app.service.spec,
			healthcheck: { type: "command" as const, command: ["/bin/check", "-q"] },
		};
		expect(test_({ ...app, service: { ...app.service, spec } })).toEqual([
			"CMD",
			"/bin/check",
			"-q",
		]);
	});
});

test("minted credentials satisfy every engine's required env", () => {
	for (const engine of Object.keys(dbEnv) as DatabaseEngine[])
		expect(() =>
			compileService({ ...database(engine), env: databaseCredentials(engine) }),
		).not.toThrow();
});

test("database without credentials in env is a compile error", () => {
	expect(() => compileService({ ...database("postgres"), env: {} })).toThrow(
		/needs env POSTGRES_PASSWORD/,
	);
});

test("scope prefixes every derived name and adds labels", () => {
	const scoped = withFiles({
		...stateful,
		scope: { namePrefix: "ls-test-x-", labels: { "logistack.test": "x" } },
	});
	const spec = compileService(scoped);
	expect(spec.Name.startsWith("ls-test-x-ls-svc-")).toBe(true);
	expect(spec.Labels?.["logistack.test"]).toBe("x");
	for (const m of spec.TaskTemplate.ContainerSpec.Mounts ?? [])
		if (m.Type === "volume")
			expect(m.Source.startsWith("ls-test-x-")).toBe(true);
	for (const f of serviceFiles(scoped))
		expect(f.name.startsWith("ls-test-x-")).toBe(true);
});

/** Shaped like the migrated factorio and filebrowser services. */
const hostApp: CompileServiceInput = {
	...app,
	service: {
		...app.service,
		spec: {
			kind: "application",
			source: { type: "image", image: "factoriotools/factorio:stable" },
			build: { type: "image" },
			ports: [{ target: 34197, published: 34197, protocol: "udp" }],
			replicas: 1,
			resources: {},
			placement: [],
			mounts: [
				{
					kind: "bind",
					hostPath: "/home/gaming/factorio",
					target: "/factorio",
				},
				{
					kind: "bind",
					hostPath: "/srv/config",
					target: "/config",
					readOnly: true,
				},
			],
			user: "845:845",
			capAdd: ["NET_BIND_SERVICE"],
			capDrop: ["ALL"],
			restart: "on-failure",
		},
	},
	pinNodeId: "node-abc",
};

describe("host-level application settings", () => {
	test("snapshot", () => {
		expect(compileService(hostApp)).toMatchSnapshot();
	});

	test("bind mounts compile to Type bind with the host path as source", () => {
		expect(compileService(hostApp).TaskTemplate.ContainerSpec.Mounts).toEqual([
			{
				Type: "bind",
				Source: "/home/gaming/factorio",
				Target: "/factorio",
				ReadOnly: false,
			},
			{
				Type: "bind",
				Source: "/srv/config",
				Target: "/config",
				ReadOnly: true,
			},
		]);
	});

	test("bind mounts pin the service, and refuse to compile without a node", () => {
		expect(compileService(hostApp).TaskTemplate.Placement?.Constraints).toEqual(
			["node.id==node-abc"],
		);
		expect(() => compileService({ ...hostApp, pinNodeId: undefined })).toThrow(
			/needs a node to pin/,
		);
	});

	test("published ports default to host mode and roll stop-first", () => {
		const spec = compileService(hostApp);
		expect(spec.EndpointSpec?.Ports).toEqual([
			{
				Protocol: "udp",
				TargetPort: 34197,
				PublishedPort: 34197,
				PublishMode: "host",
			},
		]);
		expect(spec.UpdateConfig?.Order).toBe("stop-first");
		expect(spec.RollbackConfig?.Order).toBe("stop-first");
		const stateless = compileService({
			...hostApp,
			service: {
				...hostApp.service,
				spec: {
					...hostApp.service.spec,
					mounts: [],
				} as typeof app.service.spec,
			},
		});
		expect(stateless.UpdateConfig?.Order).toBe("stop-first");
	});

	test("user, capabilities with the CAP_ prefix, and the restart condition", () => {
		const spec = compileService(hostApp);
		expect(spec.TaskTemplate.ContainerSpec).toMatchObject({
			User: "845:845",
			CapabilityAdd: ["CAP_NET_BIND_SERVICE"],
			CapabilityDrop: ["ALL"],
		});
		expect(spec.TaskTemplate.RestartPolicy?.Condition).toBe("on-failure");
	});

	test("unset fields leave the container spec as before", () => {
		const spec = compileService(app);
		const c = spec.TaskTemplate.ContainerSpec;
		expect(c.User).toBeUndefined();
		expect(c.CapabilityAdd).toBeUndefined();
		expect(c.CapabilityDrop).toBeUndefined();
		expect(spec.TaskTemplate.RestartPolicy?.Condition).toBe("any");
	});
});
