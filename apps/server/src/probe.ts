import { isIP } from "node:net";
import type { ApplicationSource } from "@logistack/contracts";
import type { Config } from "./config.ts";
import {
	BlockedHostError,
	guardedFetch,
	type HostPolicy,
	resolvePublic,
} from "./ssrf.ts";

/** Outbound checks the setup and service wizards run before anything is saved. */

export type SourceCheck = { ok: boolean; message: string; detail?: string };

let detected: Promise<string | null> | undefined;

/** `PUBLIC_IP` when configured, otherwise the address Cloudflare sees us from; null when offline. */
export function publicIp(config: Pick<Config, "PUBLIC_IP">) {
	if (config.PUBLIC_IP) return Promise.resolve(config.PUBLIC_IP);
	detected ??= fetch("https://1.1.1.1/cdn-cgi/trace", {
		signal: AbortSignal.timeout(3000),
	})
		.then((r) => r.text())
		.then((text) => {
			const ip = /^ip=(.+)$/m.exec(text)?.[1]?.trim();
			return ip && isIP(ip) ? ip : null;
		})
		.catch(() => null)
		.then((ip) => {
			// Retry on the next call rather than caching a miss.
			if (!ip) detected = undefined;
			return ip;
		});
	return detected;
}

/** A and AAAA records over DNS-over-HTTPS, so the answer is the public one, not a local cache's. */
export async function resolveHost(hostname: string): Promise<string[]> {
	const lookup = async (type: "A" | "AAAA") => {
		const url = new URL("https://cloudflare-dns.com/dns-query");
		url.search = new URLSearchParams({ name: hostname, type }).toString();
		const res = await fetch(url, {
			headers: { accept: "application/dns-json" },
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) throw new Error(`DNS-over-HTTPS returned ${res.status}`);
		const body = (await res.json()) as {
			Answer?: { type: number; data: string }[];
		};
		return (body.Answer ?? [])
			.filter((a) => a.type === 1 || a.type === 28)
			.map((a) => a.data);
	};
	return (await Promise.all([lookup("A"), lookup("AAAA")])).flat();
}

/** `github.com/o/r` or `https://github.com/o/r` to an https URL; null for anything else (ssh, file, ext::, credentials). */
export function gitUrl(repository: string): string | null {
	const raw = repository.trim();
	const url = URL.parse(raw.includes("://") ? raw : `https://${raw}`);
	if (url?.protocol !== "https:" || url.username || url.password) return null;
	return url.href;
}

const blockedCheck = (err: BlockedHostError): SourceCheck => ({
	ok: false,
	message: "This host isn't allowed",
	detail: err.message,
});

export async function checkGit(
	source: Extract<ApplicationSource, { type: "git" }>,
	policy: HostPolicy,
): Promise<SourceCheck> {
	const url = gitUrl(source.repository);
	if (!url)
		return {
			ok: false,
			message: "Use an https Git URL",
			detail:
				"Like github.com/acme/shop. Credentials in the URL aren't accepted.",
		};
	const { hostname, port } = new URL(url);
	let address: string;
	try {
		address = await resolvePublic(hostname, policy);
	} catch (err) {
		if (err instanceof BlockedHostError) return blockedCheck(err);
		throw err;
	}
	const pinned = isIP(address) === 6 ? `[${address}]` : address;
	const proc = Bun.spawn(
		[
			"git",
			// The server's own credential helpers must not make a private repository look public.
			"-c",
			"credential.helper=",
			// Connect to the address just checked, and never follow a redirect to an unchecked one.
			"-c",
			`http.curloptResolve=${hostname}:${port || 443}:${pinned}`,
			"-c",
			"http.followRedirects=false",
			"ls-remote",
			"--exit-code",
			"--heads",
			"--",
			url,
			source.branch,
		],
		{
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				GIT_TERMINAL_PROMPT: "0",
				GIT_ALLOW_PROTOCOL: "https",
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 15_000,
		},
	);
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code === 0) {
		const sha = out.split("\t")[0]?.slice(0, 7);
		return {
			ok: true,
			message: `Branch ${source.branch} found`,
			detail: sha ? `Latest commit ${sha}` : undefined,
		};
	}
	if (code === 2)
		return {
			ok: false,
			message: `Branch ${source.branch} not found`,
			detail: "The repository is reachable but has no branch with that name.",
		};
	return {
		ok: false,
		message: "Can't read this repository",
		detail:
			err.trim().split("\n").at(-1) ||
			"Private repositories need a connected Git provider.",
	};
}

export type ImageRef = {
	registry: string;
	repository: string;
	reference: string;
};

const NAME =
	/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const REGISTRY =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

/** `nginx:alpine`, `ghcr.io/o/app@sha256:...` into registry, repository and tag or digest. */
export function parseImageRef(image: string): ImageRef | null {
	let rest = image.trim();
	let reference = "latest";
	const at = rest.indexOf("@");
	if (at >= 0) {
		reference = rest.slice(at + 1);
		rest = rest.slice(0, at);
		if (!/^sha256:[a-f0-9]{64}$/.test(reference)) return null;
	} else {
		const colon = rest.lastIndexOf(":");
		if (colon > rest.lastIndexOf("/")) {
			reference = rest.slice(colon + 1);
			rest = rest.slice(0, colon);
			if (!/^[\w][\w.-]{0,127}$/.test(reference)) return null;
		}
	}
	const [first = "", ...path] = rest.split("/");
	const hasRegistry =
		path.length > 0 &&
		(first.includes(".") || first.includes(":") || first === "localhost");
	const registry = hasRegistry ? first : "registry-1.docker.io";
	let repository = hasRegistry ? path.join("/") : rest;
	if (!hasRegistry && !repository.includes("/"))
		repository = `library/${repository}`;
	if (!NAME.test(repository) || !REGISTRY.test(registry)) return null;
	return { registry, repository, reference };
}

const MANIFEST_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Anonymous pull token from a `WWW-Authenticate: Bearer realm=...` challenge. */
async function anonymousToken(
	challenge: string,
	policy: HostPolicy,
): Promise<string | null> {
	const params = Object.fromEntries(
		[...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
	);
	const realm = params.realm ? URL.parse(params.realm) : null;
	if (realm?.protocol !== "https:") return null;
	if (params.service) realm.searchParams.set("service", params.service);
	if (params.scope) realm.searchParams.set("scope", params.scope);
	const res = await guardedFetch(
		realm,
		{ signal: AbortSignal.timeout(10_000) },
		policy,
	);
	if (!res.ok) return null;
	const body = (await res.json()) as { token?: string; access_token?: string };
	return body.token ?? body.access_token ?? null;
}

export async function checkImage(
	image: string,
	policy: HostPolicy,
): Promise<SourceCheck> {
	const ref = parseImageRef(image);
	if (!ref)
		return {
			ok: false,
			message: "That isn't an image reference",
			detail: "Use a name like nginx:alpine or ghcr.io/acme/web:1.4.",
		};
	const url = `https://${ref.registry}/v2/${ref.repository}/manifests/${ref.reference}`;
	const head = (token?: string) =>
		guardedFetch(
			url,
			{
				method: "HEAD",
				headers: {
					accept: MANIFEST_TYPES,
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
				signal: AbortSignal.timeout(10_000),
			},
			policy,
		);
	try {
		let res = await head();
		const challenge = res.headers.get("www-authenticate");
		if (res.status === 401 && challenge?.startsWith("Bearer ")) {
			const token = await anonymousToken(challenge, policy);
			if (token) res = await head(token);
		}
		if (res.ok) {
			const digest = res.headers.get("docker-content-digest");
			return {
				ok: true,
				message: "Image found",
				detail: digest
					? `${ref.registry === "registry-1.docker.io" ? "Docker Hub" : ref.registry} · ${digest.slice(0, 19)}`
					: undefined,
			};
		}
		if (res.status === 404)
			return {
				ok: false,
				message: "Image not found",
				detail: `${ref.registry} has no ${ref.repository}:${ref.reference}.`,
			};
		if (res.status === 401 || res.status === 403)
			return {
				ok: false,
				message: "Image is private or doesn't exist",
				detail: "Add registry credentials under Integrations, then test again.",
			};
		return {
			ok: false,
			message: `The registry answered ${res.status}`,
			detail: ref.registry,
		};
	} catch (err) {
		if (err instanceof BlockedHostError) return blockedCheck(err);
		return {
			ok: false,
			message: `Can't reach ${ref.registry}`,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}
