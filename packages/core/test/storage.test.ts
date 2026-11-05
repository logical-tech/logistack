import { describe, expect, test } from "bun:test";
import { type StorageEngine, storageEngines } from "@logistack/contracts";
import {
	type CompileServiceInput,
	compileService,
	serviceFiles,
} from "../src/compile-service.ts";
import {
	isPublicRead,
	newStorageKey,
	publicReadPolicy,
	STORAGE_ENV,
	scopedKeyPolicy,
	storageCredentials,
	storageEngineDefs,
} from "../src/storage.ts";

const FIXED_CREDS = {
	[STORAGE_ENV.accessKeyId]: "LSROOTKEY000000000000",
	[STORAGE_ENV.secretAccessKey]: "root-secret-0000000000000000000000000000",
	[STORAGE_ENV.adminToken]: "admin-token",
	[STORAGE_ENV.rpcSecret]: "a".repeat(64),
};

function storage(engine: StorageEngine): CompileServiceInput {
	const input: CompileServiceInput = {
		service: {
			id: "svc_obj0000000000000000000000",
			organizationId: "org_acme",
			environmentId: "env_prod00000000000000000000",
			slug: "files",
			desiredState: "running",
			spec: { kind: "storage", engine, resources: { memoryMb: 512 } },
		},
		deploymentId: "dep_one0000000000000000000000",
		context: { project: "p", environment: "e", service: "s", domains: [] },
		env: { ...FIXED_CREDS },
		mounts: [],
		domains: [],
		networks: {
			environment: "net-env-id",
			ingress: "net-ingress-id",
			storage: "net-storage-id",
		},
		pinNodeId: "node-1",
		fileIds: {},
	};
	return {
		...input,
		fileIds: Object.fromEntries(
			serviceFiles(input).map((f) => [f.name, `id-of-${f.name}`]),
		),
	};
}

describe("storage compile", () => {
	for (const engine of storageEngines)
		test(`snapshot ${engine}`, () => {
			expect(compileService(storage(engine))).toMatchSnapshot();
		});

	test("joins the environment and storage networks, never ingress without a domain", () => {
		for (const engine of storageEngines) {
			const nets = compileService(storage(engine)).TaskTemplate.Networks?.map(
				(n) => n.Target,
			);
			expect(nets).toEqual(["net-env-id", "net-storage-id"]);
		}
	});

	test("a public endpoint domain adds ingress", () => {
		const input = { ...storage("minio"), domains: [{ port: 9000 }] };
		expect(
			compileService(input).TaskTemplate.Networks?.map((n) => n.Target),
		).toEqual(["net-env-id", "net-ingress-id", "net-storage-id"]);
	});

	test("pinned image by digest, data volume, single replica, stop-first", () => {
		for (const engine of storageEngines) {
			const spec = compileService(storage(engine));
			const c = spec.TaskTemplate.ContainerSpec;
			expect(c.Image).toBe(storageEngineDefs[engine].image);
			expect(c.Image).toMatch(/@sha256:[0-9a-f]{64}$/);
			expect(c.Mounts?.[0]).toMatchObject({
				Type: "volume",
				Source: "ls-vol-obj0000000000000000000000",
				Target: storageEngineDefs[engine].dataDir,
			});
			expect(spec.Mode).toEqual({ Replicated: { Replicas: 1 } });
			expect(spec.UpdateConfig?.Order).toBe("stop-first");
			expect(spec.TaskTemplate.Placement?.Constraints).toContain(
				"node.id==node-1",
			);
		}
	});

	test("root credentials reach the engine's own env names", () => {
		const env = (e: StorageEngine) =>
			compileService(storage(e)).TaskTemplate.ContainerSpec.Env ?? [];
		expect(env("minio")).toContain("MINIO_ROOT_USER=LSROOTKEY000000000000");
		expect(env("rustfs")).toContain(
			"RUSTFS_SECRET_KEY=root-secret-0000000000000000000000000000",
		);
		expect(env("seaweedfs")).toContain(
			"AWS_ACCESS_KEY_ID=LSROOTKEY000000000000",
		);
		expect(env("garage")).toContain("GARAGE_ADMIN_TOKEN=admin-token");
	});

	test("garage gets its config file as a Swarm config without secrets", () => {
		const input = storage("garage");
		const files = serviceFiles(input);
		expect(files).toHaveLength(1);
		expect(files[0]?.target).toBe("/etc/garage.toml");
		expect(files[0]?.data).not.toContain(FIXED_CREDS[STORAGE_ENV.rpcSecret]);
		expect(
			compileService(input).TaskTemplate.ContainerSpec.Configs?.[0]?.File?.Name,
		).toBe("/etc/garage.toml");
		expect(serviceFiles(storage("minio"))).toEqual([]);
	});

	test("missing credentials or storage network is a compile error", () => {
		expect(() => compileService({ ...storage("minio"), env: {} })).toThrow(
			/needs env STORAGE_ACCESS_KEY_ID/,
		);
		const { storage: _, ...networks } = storage("rustfs").networks;
		expect(() => compileService({ ...storage("rustfs"), networks })).toThrow(
			/storage network/,
		);
	});
});

describe("credentials", () => {
	test("garage keys use Garage's format, others are long random strings", () => {
		const g = newStorageKey("garage");
		expect(g.accessKeyId).toMatch(/^GK[0-9a-f]{24}$/);
		expect(g.secretAccessKey).toMatch(/^[0-9a-f]{64}$/);
		const m = newStorageKey("minio");
		expect(m.accessKeyId).toMatch(/^LS[A-Z0-9]{18}$/);
		expect(m.secretAccessKey).toHaveLength(40);
		expect(newStorageKey("minio").secretAccessKey).not.toBe(m.secretAccessKey);
	});

	test("every engine gets exactly the env keys it requires", () => {
		for (const engine of storageEngines)
			expect(Object.keys(storageCredentials(engine)).sort()).toEqual(
				[...storageEngineDefs[engine].required].sort(),
			);
	});
});

describe("scoped key policy", () => {
	test("readwrite grants object writes on the named buckets only", () => {
		expect(scopedKeyPolicy(["media", "logs"], "readwrite")).toEqual({
			Version: "2012-10-17",
			Statement: [
				{
					Effect: "Allow",
					Action: [
						"s3:GetBucketLocation",
						"s3:ListBucket",
						"s3:ListBucketMultipartUploads",
					],
					Resource: ["arn:aws:s3:::media", "arn:aws:s3:::logs"],
				},
				{
					Effect: "Allow",
					Action: [
						"s3:GetObject",
						"s3:PutObject",
						"s3:DeleteObject",
						"s3:AbortMultipartUpload",
						"s3:ListMultipartUploadParts",
					],
					Resource: ["arn:aws:s3:::media/*", "arn:aws:s3:::logs/*"],
				},
			],
		});
	});

	test("read grants no write, delete or wildcard action", () => {
		const actions = scopedKeyPolicy(["media"], "read").Statement.flatMap(
			(s) => s.Action,
		);
		expect(actions).toEqual([
			"s3:GetBucketLocation",
			"s3:ListBucket",
			"s3:GetObject",
		]);
		const resources = scopedKeyPolicy(["media"], "read").Statement.flatMap(
			(s) => s.Resource,
		);
		expect(resources.every((r) => r.startsWith("arn:aws:s3:::media"))).toBe(
			true,
		);
	});

	test("no bucket is an error, not an unscoped key", () => {
		expect(() => scopedKeyPolicy([], "read")).toThrow();
	});

	test("public-read round trips through isPublicRead", () => {
		expect(isPublicRead(publicReadPolicy("site"))).toBe(true);
		expect(isPublicRead(scopedKeyPolicy(["site"], "read"))).toBe(false);
		expect(isPublicRead(null)).toBe(false);
		expect(
			isPublicRead({
				Statement: [
					{ Effect: "Allow", Principal: "*", Action: "s3:GetObject" },
				],
			}),
		).toBe(true);
	});
});
