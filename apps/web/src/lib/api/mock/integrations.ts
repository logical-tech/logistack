import { ApiError } from "../adapter";
import type {
	GitProvider,
	GitRepo,
	GitTrigger,
	IntegrationsApi,
	Registry,
	SshKey,
} from "../integrations";

/** Realistic, jittered latency so loading states are seen in dev. */
function delay<T>(value: T, ms = 220 + Math.random() * 380): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const BASE = "https://logistack.srv1.logical.it";
const ago = (days: number) =>
	new Date(Date.now() - days * 86_400_000).toISOString();

const GITHUB_REPOS: GitRepo[] = [
	"storefront",
	"storefront-admin",
	"checkout",
	"catalog-api",
	"search-indexer",
	"payments",
	"payments-webhooks",
	"inventory",
	"inventory-sync",
	"notifications",
	"mailer",
	"auth",
	"auth-ui",
	"design-system",
	"docs",
	"marketing-site",
	"status-page",
	"analytics-pipeline",
	"image-resizer",
	"pdf-renderer",
	"feature-flags",
	"infra",
	"ops-scripts",
	"mobile-bff",
].map((name, i) => ({
	fullName: `acme-retail/${name}`,
	private: i % 5 !== 3,
	defaultBranch: i % 7 === 2 ? "master" : "main",
}));

const GITLAB_REPOS: GitRepo[] = [
	"platform/gateway",
	"platform/billing",
	"platform/ledger",
	"platform/reports",
	"tools/ci-templates",
	"tools/backup-runner",
	"web/intranet",
	"web/booking",
	"web/booking-admin",
].map((fullName) => ({ fullName, private: true, defaultBranch: "main" }));

const SSH_REPO = "ssh://git@git.internal.lan:2222/infra/ops.git";

const repos: Record<string, GitRepo[]> = {
	gpr_github: GITHUB_REPOS,
	gpr_gitlab: GITLAB_REPOS,
	gpr_ssh: [{ fullName: SSH_REPO, private: true }],
};

const providers: GitProvider[] = [
	{
		id: "gpr_github",
		kind: "github",
		name: "logical-deploy",
		state: "connected",
		message: null,
		repoCount: GITHUB_REPOS.length,
		webhookUrl: `${BASE}/api/webhooks/git/gpr_github`,
		appUrl: "https://github.com/apps/logical-deploy",
		installUrl: "https://github.com/apps/logical-deploy/installations/new",
		createdAt: ago(64),
	},
	{
		id: "gpr_gitlab",
		kind: "gitlab",
		name: "gitlab.logical.it",
		state: "connected",
		message: null,
		repoCount: GITLAB_REPOS.length,
		webhookUrl: `${BASE}/api/webhooks/git/gpr_gitlab`,
		appUrl: null,
		installUrl: null,
		createdAt: ago(41),
	},
	{
		id: "gpr_pending",
		kind: "github",
		name: "acme-retail-previews",
		state: "pending",
		message: "Install the app on an account to finish",
		repoCount: null,
		webhookUrl: `${BASE}/api/webhooks/git/gpr_pending`,
		appUrl: "https://github.com/apps/acme-retail-previews",
		installUrl:
			"https://github.com/apps/acme-retail-previews/installations/new",
		createdAt: ago(2),
	},
	{
		id: "gpr_ssh",
		kind: "generic",
		name: "git.internal.lan/infra/ops",
		state: "connected",
		message: null,
		repoCount: 1,
		webhookUrl: null,
		appUrl: null,
		installUrl: null,
		createdAt: ago(12),
	},
];

const BRANCHES = ["develop", "staging", "release/2.4", "feat/search"];

/** The repository's default branch first, then the shared feature branches. */
const branchesOf = (providerId: string, repo: string) => [
	repos[providerId]?.find((r) => r.fullName === repo)?.defaultBranch ?? "main",
	...BRANCHES,
];

const sshKeys: SshKey[] = [
	{
		id: "ssh_ops",
		name: "ops-deploy",
		publicKey:
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3pX0xQ7mJ2v9b8Wd4nRf6tLsYhCqEaZu1oGkPjV5Nd logistack:ops-deploy",
		fingerprint: "SHA256:7f1Qk2mZx9VbR4cN0aLp3sHt8wYeD6uJiO5gKqTn2Ec",
		createdAt: ago(12),
	},
];

const local = {
	enabled: true,
	url: "registry.srv1.logical.it" as string | null,
	registryId: "reg_local" as string | null,
};

const registries: Registry[] = [
	{
		id: "reg_local",
		kind: "local",
		url: "registry.srv1.logical.it",
		username: "logistack",
		hasPassword: true,
		isDefault: true,
		keepTags: 10,
		createdAt: ago(64),
	},
	{
		id: "reg_ghcr",
		kind: "ghcr",
		url: "ghcr.io/acme-retail",
		username: "acme-ci",
		hasPassword: true,
		isDefault: false,
		keepTags: 20,
		createdAt: ago(30),
	},
];

const find = <T extends { id: string }>(
	rows: T[],
	id: string,
	what: string,
) => {
	const row = rows.find((r) => r.id === id);
	if (!row) throw new ApiError(404, `${what} not found`, "not_found");
	return row;
};

const watchPaths = new Map<string, string[]>();
const gitTriggers = new Map<string, GitTrigger>();

const host = (url: string) => URL.parse(url)?.host ?? url;

export const mockIntegrations: IntegrationsApi = {
	git: {
		list: () => delay(providers),
		test: (p) => {
			const secret =
				p.kind === "bitbucket"
					? p.accessToken
					: p.kind === "generic"
						? p.sshKeyId
						: p.kind === "github"
							? p.privateKey
							: p.token;
			if (secret.includes("bad"))
				return delay(
					{
						ok: false,
						message: "The provider rejected the request",
						detail: "401 Unauthorized: the token is invalid or expired.",
					},
					900,
				);
			if (p.kind === "generic")
				return delay(
					{ ok: true, message: `Reached ${p.repoUrl}: 5 branches` },
					1100,
				);
			return delay(
				{ ok: true, message: "Connected: 9 repositories visible" },
				1100,
			);
		},
		create: ({ name, provider }) => {
			const id = rid("gpr");
			providers.unshift({
				id,
				kind: provider.kind,
				name,
				state: "connected",
				message: null,
				repoCount: provider.kind === "generic" ? 1 : 9,
				webhookUrl:
					provider.kind === "generic" ? null : `${BASE}/api/webhooks/git/${id}`,
				appUrl: null,
				installUrl: null,
				createdAt: new Date().toISOString(),
			});
			repos[id] =
				provider.kind === "generic"
					? [{ fullName: provider.repoUrl, private: true }]
					: GITLAB_REPOS;
			return delay({ id }, 500);
		},
		githubManifest: ({ name, organization }) => {
			const id = rid("gpr");
			const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
			providers.unshift({
				id,
				kind: "github",
				name,
				state: "pending",
				message: "Install the app on an account to finish",
				repoCount: null,
				webhookUrl: `${BASE}/api/webhooks/git/${id}`,
				appUrl: `https://github.com/apps/${slug}`,
				installUrl: `https://github.com/apps/${slug}/installations/new`,
				createdAt: new Date().toISOString(),
			});
			const owner = organization ? `organizations/${organization}/` : "";
			return delay(
				{
					providerId: id,
					action: `https://github.com/${owner}settings/apps/new?state=${id}.mock`,
					manifest: { name, url: BASE },
				},
				500,
			);
		},
		githubInstallation: (id) => {
			const p = find(providers, id, "git provider");
			Object.assign(p, {
				state: "connected",
				message: null,
				repoCount: GITHUB_REPOS.length,
			});
			repos[id] = GITHUB_REPOS;
			return delay({ installationId: "58214077" }, 700);
		},
		testSaved: (id) => {
			const p = find(providers, id, "git provider");
			return delay(
				p.state === "pending"
					? {
							ok: false,
							message: "The app isn't installed yet",
							detail: "Install it on an account, then test again.",
						}
					: {
							ok: true,
							message: `Connected: ${p.repoCount ?? 0} repositories visible`,
						},
				1000,
			);
		},
		repos: (id) => delay(repos[id] ?? []),
		branches: (id, repo) =>
			delay(
				find(providers, id, "git provider").kind === "generic"
					? []
					: branchesOf(id, repo),
			),
		check: (id, { repository, branch }) => {
			const p = find(providers, id, "git provider");
			const branches = branchesOf(id, repository);
			const known = p.kind === "generic" || branches.includes(branch);
			return delay(
				known
					? { ok: true, message: `Found ${host(repository)}@${branch}` }
					: {
							ok: false,
							message: `Branch ${branch} not found`,
							detail: `${repository} has ${branches.join(", ")}.`,
						},
				900,
			);
		},
		webhook: (id) => {
			const p = find(providers, id, "git provider");
			if (p.kind === "github")
				return delay({
					status: "not_needed" as const,
					message:
						"The GitHub App's webhook covers every installed repository.",
				});
			if (p.kind === "generic")
				return delay({
					status: "not_needed" as const,
					message:
						"Generic SSH sources have no API: deploy by hand or call the deploy endpoint from CI.",
				});
			return delay({
				status: "registered" as const,
				message: "Push webhook registered.",
			});
		},
		remove: (id) => {
			providers.splice(
				providers.indexOf(find(providers, id, "git provider")),
				1,
			);
			return delay(undefined);
		},
	},
	sshKeys: {
		list: () => delay(sshKeys),
		create: (name) => {
			const key: SshKey = {
				id: rid("ssh"),
				name,
				publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${Math.random().toString(36).slice(2, 14)}Hq2LmT9vXcR8bN4sE1wYkA logistack:${name.replace(/\s+/g, "-")}`,
				fingerprint: `SHA256:${Math.random().toString(36).slice(2, 12)}Qk2mZx9VbR4cN0aLp3sHt8w`,
				createdAt: new Date().toISOString(),
			};
			sshKeys.unshift(key);
			return delay(key, 600);
		},
	},
	watchPaths: {
		get: (id) => delay({ paths: watchPaths.get(id) ?? [] }),
		put: (id, paths) => {
			watchPaths.set(id, paths);
			return delay({ paths });
		},
	},
	gitTrigger: {
		get: (id) =>
			delay(
				gitTriggers.get(id) ?? {
					on: "branch" as const,
					tagPattern: "*",
					waitForChecks: false,
					checksTimeoutMinutes: 30,
				},
			),
		put: (id, rules) => {
			gitTriggers.set(id, rules);
			return delay(rules);
		},
	},
	registries: {
		list: () =>
			delay({
				local: { ...local },
				registries: registries.filter(
					(r) => r.kind !== "local" || local.registryId === r.id,
				),
			}),
		test: ({ url, password }) => {
			if (password?.includes("bad"))
				return delay(
					{
						ok: false,
						message: "Login failed",
						detail: `${url.split("/")[0]} answered 401: check the username and token scopes.`,
					},
					1200,
				);
			return delay(
				{
					ok: true,
					message: `Pushed and pulled ${url}/logistack-check:check`,
				},
				1600,
			);
		},
		create: (input) => {
			const id = rid("reg");
			if (input.isDefault) for (const r of registries) r.isDefault = false;
			registries.push({
				id,
				kind: input.kind,
				url: input.url,
				username: input.username ?? null,
				hasPassword: Boolean(input.password),
				isDefault: input.isDefault ?? false,
				keepTags: input.keepTags ?? 10,
				createdAt: new Date().toISOString(),
			});
			return delay({ id }, 500);
		},
		update: (id, patch) => {
			const r = find(registries, id, "registry");
			if (patch.isDefault) for (const x of registries) x.isDefault = false;
			Object.assign(r, patch);
			return delay(undefined);
		},
		remove: (id) => {
			registries.splice(
				registries.indexOf(find(registries, id, "registry")),
				1,
			);
			return delay(undefined);
		},
		setLocal: ({ enabled, purge }) => {
			local.enabled = enabled;
			const row = registries.find((r) => r.kind === "local");
			if (enabled) {
				if (!row) {
					registries.unshift({
						id: "reg_local",
						kind: "local",
						url: "registry.srv1.logical.it",
						username: "logistack",
						hasPassword: true,
						isDefault: true,
						keepTags: 10,
						createdAt: new Date().toISOString(),
					});
				}
				for (const r of registries) r.isDefault = r.kind === "local";
				local.registryId = "reg_local";
			} else if (row) {
				row.isDefault = false;
				if (purge) {
					registries.splice(registries.indexOf(row), 1);
					local.registryId = null;
				}
			}
			return delay({ enabled, url: local.url }, 600);
		},
		credentials: (id) => {
			const r = find(registries, id, "registry");
			return delay({
				username: r.username,
				password: r.hasPassword ? "q8Zr2vLp-Xn4cKw7Tb1mYs9Hd3Gf" : null,
			});
		},
	},
};
