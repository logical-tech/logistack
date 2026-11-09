import { decrypt, storageEngineDefs } from "@logistack/core";
import { type Db, s3Destination, service } from "@logistack/db";
import { instantiate, s3Destination as s3Provider } from "@logistack/providers";
import {
	type BlobStore,
	dbBlobStore,
	orgDestinationId,
	s3BlobStore,
} from "@logistack/worker/work-blobs";
import { eq } from "drizzle-orm";
import type { Deps } from "../env.ts";
import { Failure } from "../errors.ts";
import { guardedDestination } from "../s3.ts";
import { hostPolicy } from "../ssrf.ts";
import { defaultStorageEndpoint } from "../storage.ts";

export type { BlobStore };

/** Opens an S3 destination of the organization for attachments; only `s3` kinds qualify. */
export async function openAttachmentDestination(
	deps: Deps,
	organizationId: string,
	id: string,
) {
	const [d] = await deps.db
		.select()
		.from(s3Destination)
		.where(eq(s3Destination.id, id));
	if (!d || d.organizationId !== organizationId)
		throw new Failure("not_found", "S3 destination not found");
	if (d.kind !== "s3")
		throw new Failure(
			"bad_request",
			"attachments need an S3 destination, not SFTP, WebDAV or a folder",
		);
	const config = {
		endpoint: d.endpoint,
		region: d.region,
		bucket: d.bucket,
		prefix: d.prefix,
		accessKeyId: d.accessKeyId,
		secretAccessKey: await decrypt(deps.masterKey, d.secretEncrypted),
		forcePathStyle: d.forcePathStyle,
	};
	if (d.storageServiceId) {
		const [svc] = await deps.db
			.select({ spec: service.spec })
			.from(service)
			.where(eq(service.id, d.storageServiceId));
		if (svc?.spec.kind !== "storage")
			throw new Failure(
				"conflict",
				"the destination's storage service is gone",
			);
		const port = storageEngineDefs[svc.spec.engine].s3Port;
		return instantiate(s3Provider, {
			...config,
			endpoint: (deps.storageEndpoint ?? defaultStorageEndpoint)(
				d.storageServiceId,
				port,
			),
			forcePathStyle: true,
		});
	}
	return guardedDestination(config, await hostPolicy(deps.db));
}

/** Where new attachments of the organization go: its destination, else Postgres. */
export async function writeStore(
	deps: Deps,
	db: Db,
	organizationId: string,
): Promise<BlobStore> {
	const id = await orgDestinationId(deps.db, organizationId);
	if (!id) return dbBlobStore(db);
	return s3BlobStore(
		db,
		await openAttachmentDestination(deps, organizationId, id),
		organizationId,
	);
}

/** The store an existing attachment row lives in. */
export async function storeFor(
	deps: Deps,
	organizationId: string,
	driver: "db" | "s3",
): Promise<BlobStore> {
	if (driver === "db") return dbBlobStore(deps.db);
	const id = await orgDestinationId(deps.db, organizationId);
	if (!id)
		throw new Failure(
			"conflict",
			"this attachment is on S3 but the organization has no attachment destination",
		);
	return s3BlobStore(
		deps.db,
		await openAttachmentDestination(deps, organizationId, id),
		organizationId,
	);
}
