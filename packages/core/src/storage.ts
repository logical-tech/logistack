import type {
	StorageCapabilities,
	StorageEngine,
	StorageKeyAccess,
} from "@logistack/contracts";

/** Service env vars (secret, service scope) holding the root credentials; minted at service creation. */
export const STORAGE_ENV = {
	accessKeyId: "STORAGE_ACCESS_KEY_ID",
	secretAccessKey: "STORAGE_SECRET_ACCESS_KEY",
	/** Garage only: admin API bearer token and cluster RPC secret. */
	adminToken: "STORAGE_ADMIN_TOKEN",
	rpcSecret: "STORAGE_RPC_SECRET",
} as const;

export const STORAGE_REGION = "us-east-1";

type Env = Record<string, string>;

export type StorageEngineDef = {
	label: string;
	/** Pinned by digest; bumped deliberately with a LogiStack release. */
	image: string;
	version: string;
	s3Port: number;
	consolePort?: number;
	/** Garage: the admin API that bootstraps the layout and manages keys. Never published. */
	adminPort?: number;
	dataDir: string;
	capabilities: StorageCapabilities;
	/** Env keys `storageCredentials` mints for this engine. */
	required: string[];
	/** Engine env derived from the root credentials. */
	env: (e: Env) => Env;
	/** Container args after the image entrypoint. */
	args?: string[];
	healthcheck: string[];
	/** Read-only config files the engine needs, mounted as Swarm configs (no secrets inside). */
	files?: { target: string; content: string }[];
};

const ROOT = [STORAGE_ENV.accessKeyId, STORAGE_ENV.secretAccessKey];
const all: StorageCapabilities = {
	versioning: true,
	bucketPolicy: true,
	accessKeys: true,
	usage: true,
	console: true,
};

const GARAGE_TOML = `metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "lmdb"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"

[s3_api]
s3_region = "${STORAGE_REGION}"
api_bind_addr = "[::]:3900"

[admin]
api_bind_addr = "[::]:3903"
`;

export const storageEngineDefs: Record<StorageEngine, StorageEngineDef> = {
	minio: {
		label: "MinIO",
		// MinIO stopped publishing community images in 2025; Chainguard builds each release from source.
		image:
			"cgr.dev/chainguard/minio@sha256:3c60a2a8c4d33409a9bc7a623a7fcbfb4605adc3d89422d2f53b3f673a6e5597",
		version: "RELEASE.2026-10-23T20-06-51Z",
		s3Port: 9000,
		consolePort: 9001,
		dataDir: "/data",
		capabilities: all,
		required: ROOT,
		env: (e) => ({
			MINIO_ROOT_USER: e[STORAGE_ENV.accessKeyId] ?? "",
			MINIO_ROOT_PASSWORD: e[STORAGE_ENV.secretAccessKey] ?? "",
		}),
		args: ["server", "/data", "--console-address", ":9001"],
		// No curl or wget in the image: bash speaks HTTP over /dev/tcp.
		healthcheck: [
			"CMD",
			"bash",
			"-c",
			'exec 3<>/dev/tcp/127.0.0.1/9000 && printf "GET /minio/health/live HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n" >&3 && read -r line <&3 && [[ $line == *" 200 "* ]]',
		],
	},
	rustfs: {
		label: "RustFS",
		image:
			"rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2",
		version: "1.0.4",
		s3Port: 9000,
		consolePort: 9001,
		dataDir: "/data",
		capabilities: all,
		required: ROOT,
		env: (e) => ({
			RUSTFS_ACCESS_KEY: e[STORAGE_ENV.accessKeyId] ?? "",
			RUSTFS_SECRET_KEY: e[STORAGE_ENV.secretAccessKey] ?? "",
			RUSTFS_VOLUMES: "/data",
			RUSTFS_ADDRESS: ":9000",
			RUSTFS_CONSOLE_ENABLE: "true",
			RUSTFS_CONSOLE_ADDRESS: ":9001",
		}),
		healthcheck: [
			"CMD",
			"curl",
			"-fsS",
			"-o",
			"/dev/null",
			"http://127.0.0.1:9000/health",
		],
	},
	garage: {
		label: "Garage",
		image:
			"dxflrs/garage:v2.5.0@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5",
		version: "v2.5.0",
		s3Port: 3900,
		adminPort: 3903,
		dataDir: "/var/lib/garage",
		capabilities: {
			versioning: false,
			bucketPolicy: false,
			accessKeys: true,
			usage: true,
			console: false,
		},
		required: [...ROOT, STORAGE_ENV.adminToken, STORAGE_ENV.rpcSecret],
		env: (e) => ({
			GARAGE_RPC_SECRET: e[STORAGE_ENV.rpcSecret] ?? "",
			GARAGE_ADMIN_TOKEN: e[STORAGE_ENV.adminToken] ?? "",
		}),
		// A scratch image: the CLI itself checks the node answers RPC.
		healthcheck: ["CMD", "/garage", "status"],
		files: [{ target: "/etc/garage.toml", content: GARAGE_TOML }],
	},
	seaweedfs: {
		label: "SeaweedFS",
		image:
			"chrislusf/seaweedfs:4.52@sha256:57877e32bb90073b37dc109b438ba66e84fd5ed9ced5f5c04f56444ef243ce59",
		version: "4.52",
		s3Port: 8333,
		dataDir: "/data",
		capabilities: { ...all, usage: false, console: false },
		required: ROOT,
		// The S3 gateway turns AWS_* into its admin identity.
		env: (e) => ({
			AWS_ACCESS_KEY_ID: e[STORAGE_ENV.accessKeyId] ?? "",
			AWS_SECRET_ACCESS_KEY: e[STORAGE_ENV.secretAccessKey] ?? "",
		}),
		args: [
			"mini",
			"-dir=/data",
			"-s3.iam.readOnly=false",
			"-s3.iam.selfServiceRequiresGrant=true",
			"-admin.ui=false",
		],
		healthcheck: [
			"CMD",
			"wget",
			"-q",
			"-O",
			"/dev/null",
			"http://127.0.0.1:8333/healthz",
		],
	},
};

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomString(length: number, alphabet: string): string {
	// Rejection sampling keeps every symbol equally likely.
	const limit = 256 - (256 % alphabet.length);
	let out = "";
	while (out.length < length)
		for (const b of crypto.getRandomValues(new Uint8Array(length * 2)))
			if (b < limit && out.length < length)
				out += alphabet[b % alphabet.length];
	return out;
}

const hex = (bytes: number) =>
	crypto.getRandomValues(new Uint8Array(bytes)).toHex();

/** A fresh access key pair in the engine's own format (Garage keys are `GK` + 24 hex). */
export function newStorageKey(engine: StorageEngine): {
	accessKeyId: string;
	secretAccessKey: string;
} {
	if (engine === "garage")
		return { accessKeyId: `GK${hex(12)}`, secretAccessKey: hex(32) };
	return {
		accessKeyId: `LS${randomString(18, ALNUM)}`,
		secretAccessKey: randomString(40, `${ALNUM}abcdefghijklmnopqrstuvwxyz`),
	};
}

/** The root credentials a new storage service is created with, as env key to value. */
export function storageCredentials(engine: StorageEngine): Env {
	const key = newStorageKey(engine);
	return {
		[STORAGE_ENV.accessKeyId]: key.accessKeyId,
		[STORAGE_ENV.secretAccessKey]: key.secretAccessKey,
		...(engine === "garage"
			? { [STORAGE_ENV.adminToken]: hex(32), [STORAGE_ENV.rpcSecret]: hex(32) }
			: {}),
	};
}

export type IamPolicy = {
	Version: "2012-10-17";
	Statement: {
		Effect: "Allow";
		Action: string[];
		Resource: string[];
	}[];
};

/**
 * IAM policy for a key limited to `buckets`. Bucket-level actions go on the bucket ARN,
 * object actions on `<bucket>/*`; nothing grants s3:ListAllMyBuckets or another bucket.
 */
export function scopedKeyPolicy(
	buckets: readonly string[],
	access: StorageKeyAccess,
): IamPolicy {
	if (!buckets.length)
		throw new Error("a scoped key needs at least one bucket");
	const objectActions =
		access === "read"
			? ["s3:GetObject"]
			: [
					"s3:GetObject",
					"s3:PutObject",
					"s3:DeleteObject",
					"s3:AbortMultipartUpload",
					"s3:ListMultipartUploadParts",
				];
	return {
		Version: "2012-10-17",
		Statement: [
			{
				Effect: "Allow",
				Action: [
					"s3:GetBucketLocation",
					"s3:ListBucket",
					...(access === "readwrite" ? ["s3:ListBucketMultipartUploads"] : []),
				],
				Resource: buckets.map((b) => `arn:aws:s3:::${b}`),
			},
			{
				Effect: "Allow",
				Action: objectActions,
				Resource: buckets.map((b) => `arn:aws:s3:::${b}/*`),
			},
		],
	};
}

/** Anonymous GetObject on every key: what "public-read" means for a bucket. */
export function publicReadPolicy(bucket: string): object {
	return {
		Version: "2012-10-17",
		Statement: [
			{
				Effect: "Allow",
				Principal: { AWS: ["*"] },
				Action: ["s3:GetObject"],
				Resource: [`arn:aws:s3:::${bucket}/*`],
			},
		],
	};
}

/** Whether a bucket policy read back from the engine grants anonymous reads. */
export function isPublicRead(policy: unknown): boolean {
	const statements = (policy as { Statement?: unknown })?.Statement;
	if (!Array.isArray(statements)) return false;
	return statements.some((s) => {
		const st = s as {
			Effect?: string;
			Principal?: unknown;
			Action?: unknown;
		};
		const principal = st.Principal as { AWS?: unknown } | string | undefined;
		const anyone =
			principal === "*" ||
			(typeof principal === "object" && [principal.AWS].flat().includes("*"));
		const actions = [st.Action].flat();
		return (
			st.Effect === "Allow" &&
			anyone &&
			actions.some((a) => a === "s3:GetObject" || a === "s3:*")
		);
	});
}
