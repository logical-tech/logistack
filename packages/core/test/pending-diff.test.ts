import { describe, expect, test } from "bun:test";
import type { ApplicationSpec } from "@logistack/contracts";
import type { CompileServiceInput } from "../src/compile-service.ts";
import {
	diffSpecs,
	specSnapshot,
	summarizeChange,
} from "../src/pending-diff.ts";

const spec: ApplicationSpec = {
	kind: "application",
	source: { type: "image", image: "nginx:1.27" },
	build: { type: "image" },
	ports: [{ target: 80, published: 8080, protocol: "tcp", mode: "ingress" }],
	replicas: 1,
	resources: { memoryMb: 512 },
	placement: [],
};

const base: CompileServiceInput = {
	service: {
		id: "svc_app0000000000000000000000",
		organizationId: "org_acme",
		environmentId: "env_prod00000000000000000000",
		slug: "web",
		desiredState: "running",
		spec,
	},
	deploymentId: "dep_one0000000000000000000000",
	image: "nginx:1.27",
	env: { API_URL: "https://a.example.com", API_KEY: "sk-live-HUNTER2" },
	context: {
		project: "Shop",
		environment: "prod",
		service: "Web",
		domains: [],
	},
	mounts: [],
	domains: [],
	networks: { environment: "net-env-id-1", ingress: "net-ingress-id-1" },
	fileIds: {},
};

const flags = (env: Record<string, string>, secret = ["API_KEY"]) =>
	Object.fromEntries(
		Object.keys(env).map((k) => [k, { isSecret: secret.includes(k) }]),
	);

type Patch = Partial<Omit<CompileServiceInput, "service">> & {
	spec?: Partial<ApplicationSpec>;
	secret?: string[];
};
function snap(p: Patch = {}) {
	const { spec: s, secret, ...rest } = p;
	const input: CompileServiceInput = {
		...base,
		...rest,
		service: { ...base.service, spec: { ...spec, ...s } },
	};
	return specSnapshot(input, flags(input.env, secret));
}

const summaries = (before: Patch, after: Patch) =>
	diffSpecs(snap(before), snap(after)).map(summarizeChange);

describe("diffSpecs", () => {
	test("identical configuration has no changes, whatever the Docker ids", () => {
		expect(
			diffSpecs(
				snap(),
				snap({
					networks: { environment: "other-env", ingress: "other-ingress" },
					scope: { namePrefix: "ls-test-x-", labels: { a: "b" } },
				}),
			),
		).toEqual([]);
	});

	test("a stopped service shows no replica change: start and stop apply it", () => {
		const stopped = specSnapshot(
			{ ...base, service: { ...base.service, desiredState: "stopped" } },
			flags(base.env),
		);
		expect(diffSpecs(snap(), stopped)).toEqual([]);
	});

	test("env var added, removed and changed", () => {
		const changes = diffSpecs(
			snap(),
			snap({ env: { API_URL: "https://b.example.com", NEW: "1" } }),
		);
		expect(changes).toEqual([
			{ area: "env", op: "removed", key: "API_KEY", secret: true },
			{
				area: "env",
				op: "changed",
				key: "API_URL",
				secret: false,
				before: "https://a.example.com",
				after: "https://b.example.com",
			},
			{ area: "env", op: "added", key: "NEW", secret: false, after: "1" },
		]);
		expect(changes.map(summarizeChange)).toEqual([
			"env var API_KEY removed",
			"env var API_URL changed",
			"env var NEW added",
		]);
	});

	test("a secret value never appears, even when it was plain on one side", () => {
		const changes = diffSpecs(
			snap({ secret: [] }),
			snap({ env: { ...base.env, API_KEY: "sk-live-NEWVALUE" } }),
		);
		expect(changes).toEqual([
			{ area: "env", op: "changed", key: "API_KEY", secret: true },
		]);
		const body =
			JSON.stringify(changes.map(summarizeChange)) + JSON.stringify(changes);
		expect(body).not.toContain("HUNTER2");
		expect(body).not.toContain("NEWVALUE");
	});

	test("drain timeout in seconds, not nanoseconds", () => {
		expect(
			diffSpecs(snap(), snap({ spec: { drainTimeout: 30 } })),
		).toContainEqual({
			area: "other",
			path: "TaskTemplate.ContainerSpec.StopGracePeriod",
			before: "10s",
			after: "30s",
		});
	});

	test("image", () => {
		expect(summaries({}, { image: "nginx:1.28" })).toEqual([
			"image nginx:1.27 → nginx:1.28",
		]);
	});

	test("resources and replicas", () => {
		expect(
			summaries(
				{},
				{ spec: { resources: { memoryMb: 1024, cpu: 0.5 }, replicas: 3 } },
			),
		).toEqual([
			"CPU limit unlimited → 0.5 cores",
			"memory limit 512 MB → 1 GB",
			"replicas 1 → 3",
		]);
	});

	test("mounts: volumes, binds and files", () => {
		const volume = {
			id: "mnt_data000000000000000000000",
			kind: "volume" as const,
			target: "/data",
			readOnly: false,
		};
		const secret = {
			id: "mnt_key0000000000000000000000",
			kind: "secret" as const,
			target: "/run/secrets/key",
			readOnly: true,
			content: "file-secret-ONE",
		};
		const before = snap({ mounts: [volume, secret], pinNodeId: "n1" });
		const after = snap({
			mounts: [
				{ ...volume, readOnly: true },
				{ ...secret, content: "file-secret-TWO" },
			],
			spec: { mounts: [{ kind: "bind", hostPath: "/srv/x", target: "/x" }] },
			pinNodeId: "n1",
		});
		const changes = diffSpecs(before, after);
		expect(changes.map(summarizeChange)).toEqual([
			"volume mount /data changed",
			"bind mount /x added",
			"secret file /run/secrets/key changed",
		]);
		expect(JSON.stringify(changes)).not.toContain("file-secret");
	});

	test("ports", () => {
		expect(
			summaries(
				{},
				{
					spec: {
						ports: [
							{ target: 81, published: 8080, protocol: "tcp", mode: "ingress" },
							{ target: 53, published: 5353, protocol: "udp", mode: "host" },
						],
					},
				},
			),
		).toContain("port 8080/tcp now targets 81 (ingress)");
		expect(summaries({}, { spec: { ports: [] } })).toContain(
			"port 8080/tcp removed",
		);
	});

	test("domains come from the context, not as an env change", () => {
		const domain = {
			hostname: "shop.example.com",
			https: true,
			tunnel: false,
			pathPrefix: null,
			redirectTo: null,
			isGenerated: false,
		};
		expect(
			summaries(
				{},
				{
					domains: [{ port: 80 }],
					context: { ...base.context, domains: [domain] },
				},
			),
		).toEqual([
			"env var LOGISTACK_URL added",
			"domain shop.example.com added",
			"healthcheck added",
			"ingress network added",
		]);
	});

	test("anything else in the spec is reported by path", () => {
		expect(summaries({}, { spec: { command: ["serve"] } })).toEqual([
			"command changed",
		]);
	});
});
