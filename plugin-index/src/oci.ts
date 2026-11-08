import {
	PLUGIN_MANIFEST_LABEL,
	PluginManifest,
} from "../../packages/contracts/src/plugin.ts";
import { sha256Hex } from "./http.ts";

// The registry check a Worker can run: read the image's manifest label without pulling layers,
// the same steps as manifestFromImage in apps/server/src/plugins.ts, anonymous (public images
// only), and with every document checked against its digest since the registry is not trusted.

const ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type Doc = {
	manifests?: { digest: string; platform?: { os?: string } }[];
	config?: { digest: string };
};

class CheckError extends Error {}

/** Returns null when every linux image of `image` carries `manifest` as its label, else why not. */
export async function checkImage(
	image: string,
	manifest: PluginManifest,
	fetchFn: typeof fetch = fetch,
): Promise<string | null> {
	const m = /^([^/]+)\/(.+)@(sha256:[a-f0-9]{64})$/.exec(image);
	if (!m?.[1] || !m[2] || !m[3]) return "not a digest reference";
	const [, host, repo, digest] = m;
	if (/^[\d.]+(?::\d+)?$/.test(host) || host.startsWith("localhost"))
		return "the registry must be a public host name";
	const api = host === "docker.io" ? "registry-1.docker.io" : host;
	let auth: string | undefined;

	const get = async (path: string, want: string, accept = ACCEPT) => {
		const url = `https://${api}/v2/${repo}/${path}`;
		const go = () =>
			fetchFn(url, {
				headers: { accept, ...(auth ? { authorization: auth } : {}) },
				redirect: "follow",
			});
		let res = await go();
		const challenge = res.headers.get("www-authenticate") ?? "";
		if (res.status === 401 && !auth && /^Bearer\s/i.test(challenge)) {
			const p = Object.fromEntries(
				[...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]),
			);
			if (!p.realm?.startsWith("https://"))
				throw new CheckError("the registry's token realm is not https");
			const t = new URL(p.realm);
			if (p.service) t.searchParams.set("service", p.service);
			t.searchParams.set("scope", `repository:${repo}:pull`);
			const tr = await fetchFn(t);
			const tok = (await tr.json().catch(() => ({}))) as {
				token?: string;
				access_token?: string;
			};
			if (!tr.ok || !(tok.token ?? tok.access_token))
				throw new CheckError(
					`the registry gave no anonymous pull token (${tr.status}): only public images can be listed`,
				);
			auth = `Bearer ${tok.token ?? tok.access_token}`;
			res = await go();
		}
		if (!res.ok)
			throw new CheckError(
				res.status === 401 || res.status === 403
					? "the registry refused anonymous access: only public images can be listed"
					: `the registry answered ${res.status} for ${path}`,
			);
		const bytes = await res.arrayBuffer();
		if (bytes.byteLength > 4 * 1024 * 1024)
			throw new CheckError(`${path} is larger than 4 MiB`);
		if (`sha256:${await sha256Hex(bytes)}` !== want)
			throw new CheckError(`${path} does not match its digest ${want}`);
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	};

	const labelOf = async (doc: Doc) => {
		if (!doc.config?.digest) throw new CheckError("the image has no config");
		const config = (await get(
			`blobs/${doc.config.digest}`,
			doc.config.digest,
			"*/*",
		)) as { config?: { Labels?: Record<string, string> | null } };
		return config.config?.Labels?.[PLUGIN_MANIFEST_LABEL];
	};

	const want = JSON.stringify(manifest);
	try {
		const top = (await get(`manifests/${digest}`, digest)) as Doc;
		// An index: every linux image must carry the same manifest (attestations have os "unknown").
		const images = top.manifests
			? await Promise.all(
					top.manifests
						.filter((x) => x.platform?.os === "linux")
						.slice(0, 8)
						.map(
							async (x) =>
								(await get(`manifests/${x.digest}`, x.digest)) as Doc,
						),
				)
			: [top];
		if (!images.length) return "the image has no linux platform";
		for (const doc of images) {
			const raw = await labelOf(doc);
			if (!raw) return `the image has no ${PLUGIN_MANIFEST_LABEL} label`;
			let label: unknown;
			try {
				label = JSON.parse(raw);
			} catch {
				return `the ${PLUGIN_MANIFEST_LABEL} label is not JSON`;
			}
			const parsed = PluginManifest.safeParse(label);
			if (!parsed.success)
				return `the ${PLUGIN_MANIFEST_LABEL} label is not a valid manifest`;
			if (JSON.stringify(parsed.data) !== want)
				return `the ${PLUGIN_MANIFEST_LABEL} label differs from the submitted manifest`;
		}
		return null;
	} catch (e) {
		if (e instanceof CheckError) return e.message;
		return `could not read the image: ${e instanceof Error ? e.message : String(e)}`;
	}
}
