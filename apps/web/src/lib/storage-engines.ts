import type { StorageEngine } from "@logistack/contracts";

export type EngineInfo = {
	label: string;
	version: string;
	/** The port a public S3 domain routes to. */
	s3Port: number;
	/** Only engines with a web console have one. */
	consolePort: number | null;
	license: string;
	summary: string;
	/** What it is good at, then what it lacks; shown side by side in the wizard. */
	good: string[];
	missing: string[];
	versioning: boolean;
	bucketPolicy: boolean;
	usage: boolean;
};

/**
 * The wizard's view of `storageEngineDefs` in @logistack/core, which the web does not bundle.
 * storage-engines.test.ts fails when the two drift apart.
 */
export const STORAGE_ENGINES: Record<StorageEngine, EngineInfo> = {
	minio: {
		label: "MinIO",
		version: "RELEASE.2026-10-23T20-06-51Z",
		s3Port: 9000,
		consolePort: 9001,
		license: "AGPLv3",
		summary: "The most mature S3 compatibility, with a web console.",
		good: ["Most complete S3 API", "Web console", "Versioning and policies"],
		missing: [
			"Community edition in maintenance mode since 2025",
			"Image built from source by Chainguard",
		],
		versioning: true,
		bucketPolicy: true,
		usage: true,
	},
	rustfs: {
		label: "RustFS",
		version: "1.0.4",
		s3Port: 9000,
		consolePort: 9001,
		license: "Apache 2.0",
		summary: "Written in Rust, with a MinIO-compatible API and console.",
		good: ["MinIO-compatible API", "Web console", "Permissive license"],
		missing: ["Young project, fewer production years"],
		versioning: true,
		bucketPolicy: true,
		usage: true,
	},
	garage: {
		label: "Garage",
		version: "v2.5.0",
		s3Port: 3900,
		consolePort: null,
		license: "AGPLv3",
		summary: "Very light, built for small geo-distributed clusters.",
		good: ["Tiny memory footprint", "Scoped keys"],
		missing: ["No versioning", "No bucket policies", "No console"],
		versioning: false,
		bucketPolicy: false,
		usage: true,
	},
	seaweedfs: {
		label: "SeaweedFS",
		version: "4.52",
		s3Port: 8333,
		consolePort: null,
		license: "Apache 2.0",
		summary: "Strong with many small files, with IAM keys.",
		good: ["Many small files", "Versioning and policies", "IAM keys"],
		missing: ["No console here", "No usage figures"],
		versioning: true,
		bucketPolicy: true,
		usage: false,
	},
};

export const ENGINE_ORDER = Object.keys(STORAGE_ENGINES) as StorageEngine[];
