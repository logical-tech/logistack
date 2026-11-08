import {
	instantiate,
	type S3Destination,
	type S3DestinationConfig,
	s3Destination,
} from "@logistack/providers";
import {
	BlockedHostError,
	type HostPolicy,
	type Lookup,
	pinnedFetch,
	resolvePublic,
} from "./ssrf.ts";

/**
 * A destination on a user-chosen endpoint: https and public addresses only, unless the instance
 * allows private hosts (a MinIO on the LAN), which also allows plain http to them. The early check
 * gives a clear error; every request then re-checks and pins its own address.
 */
export async function guardedDestination(
	config: S3DestinationConfig,
	policy: HostPolicy,
	resolve?: Lookup,
): Promise<S3Destination> {
	const url = new URL(config.endpoint);
	if (url.protocol !== "https:" && !policy.allowPrivateHosts)
		throw new BlockedHostError(
			"only https endpoints are allowed; an instance owner can allow private hosts in Settings",
		);
	await resolvePublic(url.hostname, policy, resolve);
	return instantiate(s3Destination, config, {
		fetch: pinnedFetch(policy, { privateHttp: true, resolve }),
	});
}
