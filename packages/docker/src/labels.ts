import type { Filters, Labels, RegistryAuth } from "./types.ts";

export const LABEL_MANAGED = "logistack.managed";
export const LABEL_RESOURCE = "logistack.resource";
export const LABEL_KIND = "logistack.kind";
export const LABEL_ORG = "logistack.org";
/** On the volumes of a pull request preview: the orphan sweep removes them once their owner is gone. */
export const LABEL_DISPOSABLE = "logistack.disposable";

export type ManagedKind =
	| "service"
	| "db"
	| "network"
	| "volume"
	| "config"
	| "secret"
	| "release"
	| "probe"
	| "system";

export interface ManagedRef {
	resource: string;
	kind: ManagedKind;
	org: string;
}

/** The labels every Docker object LogiStack creates must carry. */
export function managedLabels({ resource, kind, org }: ManagedRef): Labels {
	return {
		[LABEL_MANAGED]: "true",
		[LABEL_RESOURCE]: resource,
		[LABEL_KIND]: kind,
		[LABEL_ORG]: org,
	};
}

/** Engine filters selecting only LogiStack-managed objects, optionally narrowed further. */
export function managedFilters(narrow: Partial<ManagedRef> = {}): Filters {
	const label = [`${LABEL_MANAGED}=true`];
	if (narrow.resource) label.push(`${LABEL_RESOURCE}=${narrow.resource}`);
	if (narrow.kind) label.push(`${LABEL_KIND}=${narrow.kind}`);
	if (narrow.org) label.push(`${LABEL_ORG}=${narrow.org}`);
	return { label };
}

/** Value for the `X-Registry-Auth` header: base64url of the auth JSON. */
export function registryAuthHeader(auth: RegistryAuth): string {
	return Buffer.from(JSON.stringify(auth)).toString("base64url");
}

/** Registry host of an image reference, Docker's way: a first segment with `.` or `:` (or `localhost`) is a host. */
export function imageRegistry(image: string): string {
	const first = image.split("/")[0] ?? "";
	return image.includes("/") &&
		(first.includes(".") || first.includes(":") || first === "localhost")
		? first.toLowerCase()
		: "docker.io";
}

/** Credentials only for their own registry: sent to another host they turn a public pull into "denied". */
export function authForImage(
	image: string,
	auth: RegistryAuth | undefined,
): RegistryAuth | undefined {
	if (!auth?.serveraddress) return auth;
	const host = auth.serveraddress
		.replace(/^[a-z]+:\/\//, "")
		.replace(/\/.*$/, "")
		.toLowerCase();
	const own = imageRegistry(image);
	const same =
		own === host ||
		(own === "docker.io" &&
			["index.docker.io", "registry-1.docker.io"].includes(host));
	return same ? auth : undefined;
}
