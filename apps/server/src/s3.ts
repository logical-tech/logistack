import {
	instantiate,
	type S3Destination,
	type S3DestinationConfig,
	s3Destination,
} from "@logistack/providers";
import { BlockedHostError, type HostPolicy, resolvePublic } from "./ssrf.ts";

/**
 * A destination on a user-chosen endpoint. Bun's S3 client does its own fetch, so the guard
 * runs before it: https and public addresses only, unless the instance allows private hosts
 * (a MinIO on the LAN), which also allows plain http.
 */
// shortcut: the address is checked, not pinned, so a DNS answer that changes between check and request is not caught; pin once Bun's S3Client accepts a custom fetch.
export async function guardedDestination(
	config: S3DestinationConfig,
	policy: HostPolicy,
): Promise<S3Destination> {
	const url = new URL(config.endpoint);
	if (url.protocol !== "https:" && !policy.allowPrivateHosts)
		throw new BlockedHostError(
			"only https endpoints are allowed; an instance owner can allow private hosts in Settings",
		);
	await resolvePublic(url.hostname, policy);
	return instantiate(s3Destination, config);
}
