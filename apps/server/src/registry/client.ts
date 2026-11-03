/**
 * The slice of the OCI distribution API the registry wizard needs: log in, push a tiny image,
 * pull it back. Token auth (GHCR, Docker Hub) and plain basic auth (Zot, distribution) both work.
 */

export type RegistryCredentials = { username: string; password: string };

/** `docker.io/acme` → API host `registry-1.docker.io`, repository prefix `acme`. */
export function splitRegistryUrl(url: string): {
	host: string;
	prefix: string;
} {
	const bare = url.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");
	const [host = "", ...rest] = bare.split("/");
	return {
		host: host === "docker.io" ? "registry-1.docker.io" : host,
		prefix: rest.join("/"),
	};
}

/** Docker treats loopback registries as insecure by default; everything else is HTTPS. */
const scheme = (host: string) =>
	/^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/.test(host) ? "http" : "https";

class RegistryError extends Error {}

export class Registry {
	private auth: string | undefined;
	private readonly base: string;

	constructor(
		readonly host: string,
		private readonly creds: RegistryCredentials | undefined,
		private readonly fetchFn: typeof fetch = fetch,
	) {
		this.base = `${scheme(host)}://${host}/v2`;
	}

	private basic() {
		return this.creds
			? `Basic ${btoa(`${this.creds.username}:${this.creds.password}`)}`
			: undefined;
	}

	/** Answers a 401 challenge: a bearer token from the realm, or basic credentials. */
	private async authorize(challenge: string, scope: string) {
		const bearer = /^Bearer\s+(.*)$/i.exec(challenge);
		if (!bearer) {
			this.auth = this.basic();
			return;
		}
		const params = Object.fromEntries(
			[...(bearer[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
				m[1],
				m[2],
			]),
		);
		if (!params.realm) throw new RegistryError("token realm missing");
		const url = new URL(params.realm);
		if (params.service) url.searchParams.set("service", params.service);
		url.searchParams.set("scope", scope);
		const basic = this.basic();
		const res = await this.fetchFn(url, {
			headers: basic ? { authorization: basic } : {},
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok)
			throw new RegistryError(
				res.status === 401 || res.status === 403
					? "login refused: check the username and token"
					: `token endpoint answered ${res.status}`,
			);
		const body = (await res.json()) as {
			token?: string;
			access_token?: string;
		};
		const token = body.token ?? body.access_token;
		if (!token) throw new RegistryError("token endpoint returned no token");
		this.auth = `Bearer ${token}`;
	}

	async request(
		path: string,
		init: RequestInit & { scope: string },
	): Promise<Response> {
		const { scope, ...rest } = init;
		const url = path.startsWith("http") ? path : `${this.base}${path}`;
		const send = () =>
			this.fetchFn(url, {
				...rest,
				headers: {
					...(rest.headers as Record<string, string>),
					...(this.auth ? { authorization: this.auth } : {}),
				},
				signal: AbortSignal.timeout(30_000),
			});
		let res = await send();
		if (res.status === 401) {
			await this.authorize(res.headers.get("www-authenticate") ?? "", scope);
			res = await send();
		}
		return res;
	}

	/** Pushes a blob unless the registry has it; one monolithic upload. */
	async pushBlob(repo: string, data: Uint8Array<ArrayBuffer>, digest: string) {
		const scope = `repository:${repo}:pull,push`;
		const head = await this.request(`/${repo}/blobs/${digest}`, {
			method: "HEAD",
			scope,
		});
		if (head.ok) return;
		const start = await this.request(`/${repo}/blobs/uploads/`, {
			method: "POST",
			scope,
		});
		const location = start.headers.get("location");
		if (start.status !== 202 || !location)
			throw await failure("starting an upload", start);
		const target = new URL(location, `${scheme(this.host)}://${this.host}`);
		target.searchParams.set("digest", digest);
		const put = await this.request(target.href, {
			method: "PUT",
			scope,
			headers: { "content-type": "application/octet-stream" },
			body: data,
		});
		if (put.status !== 201) throw await failure("uploading a blob", put);
	}
}

async function failure(what: string, res: Response) {
	const text = (await res.text().catch(() => "")).slice(0, 300);
	return new RegistryError(
		res.status === 401 || res.status === 403
			? `${what} was refused (${res.status}): the token needs push rights`
			: `${what} failed with ${res.status}${text ? `: ${text}` : ""}`,
	);
}

const sha256 = async (b: Uint8Array<ArrayBuffer>) =>
	`sha256:${new Uint8Array(await crypto.subtle.digest("SHA-256", b)).toHex()}`;

const MANIFEST = "application/vnd.oci.image.manifest.v1+json";

export type RegistryCheck = { ok: boolean; message: string; detail?: string };

/**
 * Logs in, pushes `<prefix>/logistack-check:check` (an empty-layer image of a few hundred bytes)
 * and pulls its manifest back. GHCR and Docker Hub keep the test package; it is overwritten in place.
 */
export async function checkRegistry(
	url: string,
	creds: RegistryCredentials | undefined,
	fetchFn: typeof fetch = fetch,
): Promise<RegistryCheck> {
	const { host, prefix } = splitRegistryUrl(url);
	if (!host) return { ok: false, message: "Enter a registry host" };
	const repo = [prefix, "logistack-check"].filter(Boolean).join("/");
	const reg = new Registry(host, creds, fetchFn);
	try {
		const ping = await reg.request("/", {
			method: "GET",
			scope: `repository:${repo}:pull,push`,
		});
		if (!ping.ok)
			return {
				ok: false,
				message:
					ping.status === 401
						? "Login refused"
						: `The registry answered ${ping.status}`,
				detail: "Check the username and the token's scopes.",
			};

		const layer = new Uint8Array(Bun.gzipSync(new Uint8Array(1024)));
		const config = new TextEncoder().encode(
			JSON.stringify({
				architecture: "amd64",
				os: "linux",
				config: {},
				rootfs: {
					type: "layers",
					diff_ids: [await sha256(new Uint8Array(1024))],
				},
			}),
		);
		const [layerDigest, configDigest] = await Promise.all([
			sha256(layer),
			sha256(config),
		]);
		await reg.pushBlob(repo, config, configDigest);
		await reg.pushBlob(repo, layer, layerDigest);
		const manifest = new TextEncoder().encode(
			JSON.stringify({
				schemaVersion: 2,
				mediaType: MANIFEST,
				config: {
					mediaType: "application/vnd.oci.image.config.v1+json",
					digest: configDigest,
					size: config.length,
				},
				layers: [
					{
						mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
						digest: layerDigest,
						size: layer.length,
					},
				],
			}),
		);
		const scope = `repository:${repo}:pull,push`;
		const put = await reg.request(`/${repo}/manifests/check`, {
			method: "PUT",
			scope,
			headers: { "content-type": MANIFEST },
			body: manifest,
		});
		if (put.status !== 201) throw await failure("pushing the manifest", put);

		const pulled = await reg.request(`/${repo}/manifests/check`, {
			method: "GET",
			scope,
			headers: { accept: MANIFEST },
		});
		if (!pulled.ok) throw await failure("pulling it back", pulled);
		const digest = await sha256(new Uint8Array(await pulled.arrayBuffer()));
		if (digest !== (await sha256(manifest)))
			return {
				ok: false,
				message: "The image came back different",
				detail: `pushed ${await sha256(manifest)}, pulled ${digest}`,
			};
		return {
			ok: true,
			message: "Logged in, pushed and pulled a test image",
			detail: `${host}/${repo}:check`,
		};
	} catch (e) {
		return {
			ok: false,
			message:
				e instanceof RegistryError ? e.message : "Couldn't reach the registry",
			...(e instanceof RegistryError
				? {}
				: { detail: e instanceof Error ? e.message : String(e) }),
		};
	}
}
