import type { StorageEngine, StorageSpec } from "@logistack/contracts";
import {
	dockerName,
	STORAGE_ENV,
	STORAGE_REGION,
	seal,
	storageEngineDefs,
	unseal,
} from "@logistack/core";
import { domain, service } from "@logistack/db";
import { type StorageClient, storageClient } from "@logistack/providers";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Deps, Env } from "./env.ts";
import { Failure, notFound } from "./errors.ts";
import { serviceEnvValues } from "./secret-refs.ts";

/**
 * Where the api dials a storage service: its Swarm service name, which resolves on `ls-storage`
 * (the api and worker join it in the stack, storage services join it at deploy). Tests override it.
 */
export const defaultStorageEndpoint = (serviceId: string, port: number) =>
	`http://${dockerName("svc", serviceId)}:${port}`;

export type StorageService = {
	id: string;
	slug: string;
	engine: StorageEngine;
	spec: StorageSpec;
	accessKeyId: string;
	secretAccessKey: string;
	client: StorageClient;
	/** `https://host` of an active domain on the S3 port, when one exists. */
	publicEndpoint: string | null;
	consoleUrl: string | null;
};

const ready = new Map<string, Promise<void>>();

async function rootEnv(deps: Deps, serviceId: string) {
	return serviceEnvValues(deps, serviceId, Object.values(STORAGE_ENV));
}

/** The storage service behind `serviceId` with its root client, bootstrapped (Garage) once per process. */
export async function openStorage(
	c: Context<Env>,
	serviceId: string,
): Promise<StorageService> {
	const deps = c.var.deps;
	const [row] = await deps.db
		.select({ slug: service.slug, spec: service.spec })
		.from(service)
		.where(eq(service.id, serviceId));
	if (!row) throw notFound("service");
	if (row.spec.kind !== "storage")
		throw new Failure("bad_request", "not a storage service");
	const spec = row.spec;
	const def = storageEngineDefs[spec.engine];
	const env = await rootEnv(deps, serviceId);
	const accessKeyId = env[STORAGE_ENV.accessKeyId];
	const secretAccessKey = env[STORAGE_ENV.secretAccessKey];
	if (!accessKeyId || !secretAccessKey)
		throw new Failure(
			"conflict",
			`the root credentials (${STORAGE_ENV.accessKeyId}) are missing from the service env`,
		);
	const endpoint = deps.storageEndpoint ?? defaultStorageEndpoint;
	const adminToken = env[STORAGE_ENV.adminToken];
	const client = storageClient({
		engine: spec.engine,
		endpoint: endpoint(serviceId, def.s3Port),
		region: STORAGE_REGION,
		accessKeyId,
		secretAccessKey,
		...(spec.engine === "garage" && adminToken
			? {
					admin: {
						endpoint: endpoint(serviceId, def.adminPort ?? 3903),
						token: adminToken,
					},
				}
			: {}),
	});
	let boot = ready.get(serviceId);
	if (!boot) {
		boot = client.ensureReady();
		ready.set(serviceId, boot);
		boot.catch(() => ready.delete(serviceId));
	}
	await boot;

	const domains = await deps.db
		.select({
			hostname: domain.hostname,
			port: domain.port,
			https: domain.https,
		})
		.from(domain)
		.where(eq(domain.serviceId, serviceId));
	const url = (port?: number) => {
		const d = port && domains.find((x) => x.port === port);
		return d ? `${d.https ? "https" : "http"}://${d.hostname}` : null;
	};
	return {
		id: serviceId,
		slug: row.slug,
		engine: spec.engine,
		spec,
		accessKeyId,
		secretAccessKey,
		client,
		publicEndpoint: url(def.s3Port),
		consoleUrl: url(def.consolePort),
	};
}

type SharePayload = { s: string; b: string; k: string; e: number };

/** Binds the ciphertext to share links: no other value sealed with the master key opens as one. */
const SHARE_AAD = "storage_share:v1";

/** An opaque download token: the payload sealed with the master key, so it can be neither read nor forged. */
export async function shareToken(deps: Deps, p: SharePayload): Promise<string> {
	return Buffer.from(
		await seal(deps.masterKey, SHARE_AAD, JSON.stringify(p)),
	).toString("base64url");
}

export async function readShareToken(
	deps: Deps,
	token: string,
): Promise<SharePayload> {
	try {
		const p = JSON.parse(
			await unseal(
				deps.masterKey,
				SHARE_AAD,
				Buffer.from(token, "base64url").toString("utf8"),
			),
		) as SharePayload;
		if (typeof p.e !== "number" || p.e < Date.now()) throw new Error("expired");
		return p;
	} catch {
		throw new Failure("not_found", "link expired or invalid");
	}
}

/** Response headers for an object handed to a browser: always a download, never rendered on our origin. */
export function downloadHeaders(res: Response, key: string): Headers {
	const name = key.split("/").at(-1) || "download";
	const h = new Headers({
		"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
		"x-content-type-options": "nosniff",
		"content-security-policy": "sandbox",
		"cache-control": "private, no-store",
	});
	for (const k of ["content-type", "content-length", "etag", "last-modified"]) {
		const v = res.headers.get(k);
		if (v) h.set(k, v);
	}
	return h;
}
