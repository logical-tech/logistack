import { z } from "zod";
import {
	type Deps,
	defineProvider,
	Http,
	ProviderError,
	secret,
} from "../http.ts";
import { normalizeGitHubStyle } from "./github-style.ts";
import {
	type CheckState,
	type GitProvider,
	type GitRepo,
	ownerRepoPath,
	repoFilePath,
	requireHmac,
	summarizeChecks,
	withCredentials,
} from "./types.ts";

const API = "https://api.github.com";
const apiHeaders = {
	accept: "application/vnd.github+json",
	"x-github-api-version": "2022-11-28",
	"user-agent": "LogiStack",
};

export type GitHubManifestInput = {
	/** App name shown on GitHub; must be unique across GitHub. */
	name: string;
	/** LogiStack's public URL, used as the app homepage. */
	url: string;
	webhookUrl: string;
	/** Where GitHub sends the user back with `?code=` after creating the app. */
	redirectUrl: string;
	/** Where GitHub sends the user after installing the app. */
	setupUrl?: string;
	public?: boolean;
};

/** The manifest JSON to POST (as the `manifest` form field) to github.com/settings/apps/new. */
export function buildGitHubAppManifest(input: GitHubManifestInput) {
	return {
		name: input.name,
		url: input.url,
		hook_attributes: { url: input.webhookUrl, active: true },
		redirect_url: input.redirectUrl,
		...(input.setupUrl ? { setup_url: input.setupUrl } : {}),
		public: input.public ?? false,
		default_permissions: {
			contents: "read",
			metadata: "read",
			pull_requests: "write",
			statuses: "write",
			checks: "read",
		},
		default_events: ["push", "pull_request", "release"],
	};
}

const conversion = z.object({
	id: z.number(),
	slug: z.string(),
	pem: z.string(),
	webhook_secret: z.string(),
	client_id: z.string(),
	client_secret: z.string(),
	html_url: z.string(),
});

/** Exchanges the manifest flow's one-time `code` for the new app's credentials. */
export async function exchangeGitHubManifestCode(code: string, deps?: Deps) {
	const http = new Http("github", deps);
	const res = conversion.parse(
		await http.json(
			"exchangeManifestCode",
			`${API}/app-manifests/${encodeURIComponent(code)}/conversions`,
			{ method: "POST", headers: apiHeaders },
		),
	);
	return {
		appId: String(res.id),
		slug: res.slug,
		privateKey: res.pem,
		webhookSecret: res.webhook_secret,
		clientId: res.client_id,
		clientSecret: res.client_secret,
		htmlUrl: res.html_url,
	};
}

const derLength = (n: number) =>
	n < 0x80
		? [n]
		: n < 0x100
			? [0x81, n]
			: n < 0x10000
				? [0x82, n >> 8, n & 0xff]
				: [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];

/** Wraps a PKCS#1 RSAPrivateKey (what GitHub hands out) in a PKCS#8 PrivateKeyInfo for WebCrypto. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
	const rsaAlgorithm = [
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
		0x01, 0x05, 0x00,
	];
	const octets = [0x04, ...derLength(pkcs1.length)];
	const bodyLength = 3 + rsaAlgorithm.length + octets.length + pkcs1.length;
	return new Uint8Array([
		0x30,
		...derLength(bodyLength),
		0x02,
		0x01,
		0x00,
		...rsaAlgorithm,
		...octets,
		...pkcs1,
	]);
}

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
	const der = Uint8Array.fromBase64(
		pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""),
	);
	const pkcs8 = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(der) : der;
	return crypto.subtle.importKey(
		"pkcs8",
		pkcs8,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

const b64url = (b: Uint8Array) =>
	b.toBase64({ alphabet: "base64url", omitPadding: true });
const b64urlJson = (v: unknown) =>
	b64url(new TextEncoder().encode(JSON.stringify(v)));

/** RS256 app JWT: issued 60s in the past for clock drift, valid 9 minutes (GitHub's max is 10). */
export async function signGitHubAppJwt(
	appId: string,
	key: CryptoKey,
	nowS = Math.floor(Date.now() / 1000),
): Promise<string> {
	const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({
		iat: nowS - 60,
		exp: nowS + 540,
		iss: appId,
	})}`;
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsigned),
	);
	return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

export const githubConfig = z.object({
	appId: z.string().regex(/^\d+$/),
	privateKey: secret().pipe(z.string().includes("PRIVATE KEY")),
	webhookSecret: secret(),
	installationId: z.string().regex(/^\d+$/),
});
export type GitHubConfig = z.infer<typeof githubConfig>;

/**
 * Points a GitHub App's webhook at `url`, keeping its secret, so an app another platform created
 * delivers to LogiStack from now on. Authenticates as the app (JWT); needs no installation.
 */
export async function pointGitHubAppHook(
	app: Pick<GitHubConfig, "appId" | "privateKey" | "webhookSecret">,
	url: string,
	deps?: Deps,
): Promise<void> {
	const jwt = await signGitHubAppJwt(
		app.appId,
		await importRsaPrivateKey(app.privateKey),
	);
	await new Http("github", deps).request(
		"updateHookConfig",
		`${API}/app/hook/config`,
		{
			method: "PATCH",
			headers: {
				...apiHeaders,
				authorization: `Bearer ${jwt}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				url,
				content_type: "json",
				insecure_ssl: "0",
				secret: app.webhookSecret,
			}),
		},
	);
}

const statusState: Record<string, CheckState> = {
	success: "success",
	pending: "pending",
	failure: "failure",
	error: "failure",
};

/** A completed run fails unless it concluded success, neutral or skipped. */
const runState = (r: {
	status: string;
	conclusion: string | null;
}): CheckState =>
	r.status !== "completed"
		? "pending"
		: ["success", "neutral", "skipped"].includes(r.conclusion ?? "")
			? "success"
			: "failure";

type Repo = {
	full_name: string;
	private: boolean;
	default_branch?: string;
};

export const github = defineProvider({
	configSchema: githubConfig,
	create(config, deps): GitProvider {
		const http = new Http("github", deps);
		let key: Promise<CryptoKey> | undefined;
		let cached: { token: string; expiresAt: number } | undefined;

		async function installationToken(): Promise<string> {
			if (cached && cached.expiresAt - Date.now() > 5 * 60_000)
				return cached.token;
			key ??= importRsaPrivateKey(config.privateKey);
			const jwt = await signGitHubAppJwt(config.appId, await key);
			const res = await http.json<{ token: string; expires_at: string }>(
				"installationToken",
				`${API}/app/installations/${config.installationId}/access_tokens`,
				{
					method: "POST",
					headers: { ...apiHeaders, authorization: `Bearer ${jwt}` },
				},
			);
			cached = {
				token: res.token,
				expiresAt: new Date(res.expires_at).getTime(),
			};
			return res.token;
		}

		async function get<T>(op: string, path: string): Promise<T> {
			return http.json<T>(op, `${API}${path}`, {
				headers: {
					...apiHeaders,
					authorization: `Bearer ${await installationToken()}`,
				},
			});
		}

		return {
			async listRepos() {
				const out: GitRepo[] = [];
				for (let page = 1; ; page++) {
					const res = await get<{ total_count: number; repositories: Repo[] }>(
						"listRepos",
						`/installation/repositories?per_page=100&page=${page}`,
					);
					for (const r of res.repositories)
						out.push({
							fullName: r.full_name,
							private: r.private,
							defaultBranch: r.default_branch,
						});
					if (res.repositories.length === 0 || out.length >= res.total_count)
						return out;
				}
			},
			async listBranches(repo) {
				const out: string[] = [];
				for (let page = 1; ; page++) {
					const res = await get<{ name: string }[]>(
						"listBranches",
						`/repos/${ownerRepoPath("github", repo)}/branches?per_page=100&page=${page}`,
					);
					out.push(...res.map((b) => b.name));
					if (res.length < 100) return out;
				}
			},
			async getCloneUrl(repo) {
				return withCredentials(
					`https://github.com/${ownerRepoPath("github", repo)}.git`,
					"x-access-token",
					await installationToken(),
				);
			},
			async readFile(repo, ref, path) {
				const res = await http.request(
					"readFile",
					`${API}/repos/${ownerRepoPath("github", repo)}/contents/${repoFilePath("github", path)}?ref=${encodeURIComponent(ref)}`,
					{
						headers: {
							...apiHeaders,
							accept: "application/vnd.github.raw+json",
							authorization: `Bearer ${await installationToken()}`,
						},
					},
				);
				return res.text();
			},
			async commitChecks(repo, ref) {
				const base = `/repos/${ownerRepoPath("github", repo)}/commits/${encodeURIComponent(ref)}`;
				// Both APIs: older CI posts commit statuses, GitHub Actions posts check runs.
				const [combined, runs] = await Promise.all([
					get<{ statuses: { context: string; state: string }[] }>(
						"commitStatus",
						`${base}/status?per_page=100`,
					),
					get<{
						check_runs: {
							name: string;
							status: string;
							conclusion: string | null;
						}[];
					}>("checkRuns", `${base}/check-runs?per_page=100`),
				]);
				return summarizeChecks([
					...combined.statuses.map((s) => ({
						name: s.context,
						state: statusState[s.state] ?? "pending",
					})),
					...runs.check_runs.map((r) => ({ name: r.name, state: runState(r) })),
				]);
			},
			async commentOnPullRequest(repo, number, body, commentId) {
				const base = `${API}/repos/${ownerRepoPath("github", repo)}/issues`;
				const send = async (method: string, url: string) =>
					http.json<{ id: number }>("prComment", url, {
						method,
						headers: {
							...apiHeaders,
							authorization: `Bearer ${await installationToken()}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({ body }),
					});
				if (commentId)
					try {
						return String(
							(
								await send(
									"PATCH",
									`${base}/comments/${encodeURIComponent(commentId)}`,
								)
							).id,
						);
					} catch (e) {
						if (!(e instanceof ProviderError && e.status === 404)) throw e;
					}
				return String((await send("POST", `${base}/${number}/comments`)).id);
			},
			async verifyWebhook(headers, rawBody) {
				await requireHmac(
					"github",
					headers,
					"x-hub-signature-256",
					"sha256=",
					config.webhookSecret,
					rawBody,
				);
				return normalizeGitHubStyle(
					headers.get("x-github-event"),
					JSON.parse(rawBody),
				);
			},
		};
	},
});
