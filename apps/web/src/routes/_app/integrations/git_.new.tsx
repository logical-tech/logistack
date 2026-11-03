import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	CircleAlert,
	ExternalLink,
	KeyRound,
	Loader2,
	User,
	Users,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { CopyField } from "@/components/copy-button";
import { Field } from "@/components/field";
import { GIT_KIND } from "@/components/integration-kinds";
import { Page, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
	ChoiceGroup,
	Instructions,
	Summary,
	TestPanel,
} from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { ApiError, isMock } from "@/lib/api";
import {
	type GitConnect,
	type GitProvider,
	gitProvidersQuery,
	integrations,
	sshKeysQuery,
	useCreateGitProvider,
	useCreateSshKey,
	usePickUpInstallation,
} from "@/lib/api/integrations";
import { stepParam } from "@/lib/search";

const KINDS = ["github", "gitlab", "gitea", "bitbucket", "generic"] as const;
type Kind = (typeof KINDS)[number];

export const Route = createFileRoute("/_app/integrations/git_/new")({
	validateSearch: z.object({
		kind: z.enum(KINDS).optional().catch(undefined),
		/** A GitHub App created on GitHub; set by the server's redirects. */
		provider: z.string().optional().catch(undefined),
		step: stepParam,
		error: z.string().optional().catch(undefined),
	}),
	staticData: { crumb: "Connect provider" },
	component: ConnectProvider,
});

type V = {
	kind: Kind;
	appName: string;
	account: "personal" | "organization";
	organization: string;
	baseUrl: string;
	token: string;
	workspace: string;
	accessToken: string;
	sshKeyId: string;
	repoUrl: string;
	knownHosts: string;
	name: string;
};

const DEFAULTS: V = {
	kind: "github",
	appName: "",
	account: "personal",
	organization: "",
	baseUrl: "",
	token: "",
	workspace: "",
	accessToken: "",
	sshKeyId: "",
	repoUrl: "",
	knownHosts: "",
	name: "",
};

const SECRETS: (keyof V)[] = ["token", "accessToken"];
const GITLAB = "https://gitlab.com";
const SSH_URL =
	/^(ssh:\/\/([\w.-]+@)?[\w.-]+(:\d+)?\/\S+|[\w.-]+@[\w.-]+:[^\s/]\S*)$/;

const trimUrl = (u: string) => u.trim().replace(/\/+$/, "");
const hostOf = (u: string) => URL.parse(trimUrl(u))?.host ?? trimUrl(u);

/** `git@host:org/repo.git` and `ssh://git@host:2222/org/repo.git` both read as `host/org/repo`. */
function sshLabel(url: string) {
	const u = url.trim().replace(/\.git$/, "");
	const scp = u.match(/^[\w.-]+@([\w.-]+):(.+)$/);
	if (scp) return `${scp[1]}/${scp[2]}`;
	const parsed = URL.parse(u);
	return parsed ? `${parsed.hostname}${parsed.pathname}` : u;
}

function derivedName(v: V) {
	if (v.kind === "gitlab") return hostOf(v.baseUrl || GITLAB);
	if (v.kind === "gitea") return hostOf(v.baseUrl);
	if (v.kind === "bitbucket") return `bitbucket.org/${v.workspace.trim()}`;
	if (v.kind === "generic") return sshLabel(v.repoUrl);
	return v.appName.trim();
}

function toConnect(v: V): GitConnect {
	if (v.kind === "gitlab")
		return {
			kind: "gitlab",
			baseUrl: trimUrl(v.baseUrl || GITLAB),
			token: v.token.trim(),
		};
	if (v.kind === "gitea")
		return {
			kind: "gitea",
			baseUrl: trimUrl(v.baseUrl),
			token: v.token.trim(),
		};
	if (v.kind === "bitbucket")
		return {
			kind: "bitbucket",
			workspace: v.workspace.trim(),
			accessToken: v.accessToken.trim(),
		};
	if (v.kind === "generic")
		return {
			kind: "generic",
			repoUrl: v.repoUrl.trim(),
			sshKeyId: v.sshKeyId,
			...(v.knownHosts.trim() ? { knownHosts: v.knownHosts.trim() } : {}),
		};
	throw new Error("GitHub connects through its App, not a token");
}

const httpsUrl = z
	.string()
	.trim()
	.regex(
		/^https?:\/\/[\w.-]+(:\d+)?(\/\S*)?$/i,
		"Use a URL like https://git.example.com",
	);
const token = (what: string) => z.string().trim().min(1, `Paste the ${what}.`);

const CHOICES = [
	{
		value: "github" as const,
		title: "GitHub",
		description:
			"Create a GitHub App in two clicks. Push and pull request webhooks are set up for you.",
		badge: "Recommended",
		icon: GIT_KIND.github.icon,
	},
	{
		value: "gitlab" as const,
		title: "GitLab",
		description:
			"gitlab.com or self-hosted, with a personal or group access token.",
		icon: GIT_KIND.gitlab.icon,
	},
	{
		value: "gitea" as const,
		title: "Gitea or Forgejo",
		description: "Your own instance, with an access token.",
		icon: GIT_KIND.gitea.icon,
	},
	{
		value: "bitbucket" as const,
		title: "Bitbucket",
		description:
			"A Bitbucket Cloud workspace, with a workspace or repository access token.",
		icon: GIT_KIND.bitbucket.icon,
	},
	{
		value: "generic" as const,
		title: "Any Git host over SSH",
		description:
			"One repository, read with a deploy key. No webhooks: deploy from CI or by hand.",
		icon: KeyRound,
	},
];

function UrlError({ message }: { message?: string }) {
	if (!message) return null;
	return (
		<p
			role="alert"
			className="flex items-start gap-2 rounded-lg bg-bad/10 px-3 py-2.5 text-sm text-bad-text"
		>
			<CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
			<span>
				<span className="font-medium">GitHub sent you back with an error.</span>{" "}
				{message}
			</span>
		</p>
	);
}

const PERMISSIONS = [
	["Contents", "Read", "Clone the code it builds."],
	["Metadata", "Read", "List repositories and branches."],
	["Pull requests", "Read and write", "Comment preview URLs on pull requests."],
	[
		"Commit statuses",
		"Read and write",
		"Report build and deploy results on commits.",
	],
] as const;

type Ctx = {
	gh: GitProvider | undefined;
	urlError: string | undefined;
	urlStep: string | undefined;
	startManifest: (v: V) => Promise<void>;
	pickUp: () => Promise<void>;
	pickingUp: boolean;
};

function buildSteps(ctx: Ctx): WizardStep<V>[] {
	const { gh } = ctx;
	const created = Boolean(gh?.appUrl);
	const installed = created && gh?.state !== "pending";
	const is =
		(...kinds: Kind[]) =>
		(v: V) =>
			kinds.includes(v.kind);
	const errorFor = (step: string) =>
		ctx.urlStep === step ? ctx.urlError : undefined;

	return [
		{
			id: "kind",
			title: "Choose a provider",
			description:
				"Where your repositories live. You can connect more than one.",
			render: (w) => (
				<ChoiceGroup
					label="Provider"
					columns={1}
					value={w.values.kind}
					onChange={(k) => {
						w.set("kind", k);
						if (k === "gitlab" && !w.values.baseUrl) w.set("baseUrl", GITLAB);
						if (k === "gitea" && w.values.baseUrl === GITLAB)
							w.set("baseUrl", "");
					}}
					choices={CHOICES}
				/>
			),
		},

		// GitHub: the App manifest flow.
		{
			id: "app",
			title: "Name the app",
			description:
				"LogiStack creates a GitHub App that you own. Its name is public and unique across GitHub.",
			when: is("github"),
			schema: (v) =>
				created
					? z.object({})
					: z.object({
							appName: z
								.string()
								.trim()
								.min(1, "Name the app.")
								.max(34, "GitHub allows up to 34 characters.")
								.regex(
									/^[\w .-]+$/,
									"Letters, numbers, spaces, dots, dashes and underscores.",
								),
							organization:
								v.account === "organization"
									? z
											.string()
											.trim()
											.regex(
												/^[a-z\d](?:[a-z\d-]{0,38})$/i,
												"Use the organization's login, like acme-retail.",
											)
									: z.string(),
						}),
			render: (w) =>
				created && gh ? (
					<p className="text-sm">
						The app <span className="font-medium">{gh.name}</span> exists on
						GitHub. To use another name, start over from the provider list.
					</p>
				) : (
					<div className="grid gap-5">
						<Field
							id="wz-appName"
							label="App name"
							error={w.error("appName")}
							hint="Up to 34 characters, like logistack-acme."
						>
							<Input
								{...w.bind("appName")}
								placeholder="logistack-acme"
								maxLength={34}
								autoComplete="off"
								spellCheck={false}
								autoFocus
							/>
						</Field>
						<ChoiceGroup
							label="Owner"
							value={w.values.account}
							onChange={(a) => w.set("account", a)}
							choices={[
								{
									value: "personal",
									title: "Personal account",
									description: "The app belongs to you.",
									icon: User,
								},
								{
									value: "organization",
									title: "Organization",
									description: "The app belongs to an organization you manage.",
									icon: Users,
								},
							]}
						/>
						{w.values.account === "organization" && (
							<Field
								id="wz-organization"
								label="Organization login"
								error={w.error("organization")}
								hint="As it appears in github.com/<login>. You need to be an owner."
							>
								<Input
									{...w.bind("organization")}
									placeholder="acme-retail"
									autoCapitalize="none"
									spellCheck={false}
									className="font-mono"
								/>
							</Field>
						)}
					</div>
				),
		},
		{
			id: "create",
			title: "Create it on GitHub",
			description:
				"GitHub shows the app with these permissions and asks you to confirm. Nothing else is requested.",
			when: is("github"),
			schema: z.object({
				appName: z
					.string()
					.refine(() => created, "Create the app on GitHub, then continue."),
			}),
			render: (w) => (
				<div className="grid gap-5">
					<UrlError message={errorFor("create")} />
					<div
						className="overflow-hidden rounded-lg ring-1 ring-border"
						data-ui
					>
						<table className="w-full text-left text-sm">
							<thead className="bg-muted/60 text-xs text-muted-foreground dark:bg-muted/40">
								<tr>
									<th className="px-3 py-2 font-medium">Permission</th>
									<th className="px-3 py-2 font-medium">Access</th>
									<th className="px-3 py-2 font-medium max-sm:hidden">
										Used to
									</th>
								</tr>
							</thead>
							<tbody>
								{PERMISSIONS.map(([name, access, why]) => (
									<tr key={name} className="border-t">
										<td className="px-3 py-2">
											{name}
											<span className="block text-xs text-muted-foreground sm:hidden">
												{why}
											</span>
										</td>
										<td className="px-3 py-2 whitespace-nowrap">{access}</td>
										<td className="px-3 py-2 text-muted-foreground max-sm:hidden">
											{why}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p className="text-sm text-muted-foreground">
						It subscribes to{" "}
						<span className="font-medium text-foreground">push</span> and{" "}
						<span className="font-medium text-foreground">pull_request</span>{" "}
						events, delivered signed to this instance.
					</p>
					{created ? (
						<p className="text-sm">
							Created as <span className="font-medium">{gh?.name}</span>.
							Continue to install it.
						</p>
					) : (
						<CreateOnGitHub w={w} start={ctx.startManifest} />
					)}
					{w.error("appName") && (
						<p className="text-xs text-bad-text" aria-live="polite">
							{w.error("appName")}
						</p>
					)}
				</div>
			),
		},
		{
			id: "install",
			title: "Install it",
			description:
				"Pick the account and the repositories LogiStack may deploy. GitHub brings you back here.",
			when: is("github"),
			schema: z.object({
				appName: z
					.string()
					.refine(() => installed, "Install the app on GitHub, then continue."),
			}),
			render: (w) => (
				<div className="grid gap-5">
					<UrlError message={errorFor("install")} />
					{installed ? (
						<p className="text-sm">
							<span className="font-medium">{gh?.name}</span> is installed.
							Continue to test it.
						</p>
					) : (
						<>
							<div className="flex flex-wrap items-center gap-3">
								{gh?.installUrl && (
									<Button asChild>
										<a href={gh.installUrl}>
											Install on GitHub
											<ExternalLink data-icon="inline-end" />
										</a>
									</Button>
								)}
								<Button
									type="button"
									variant="outline"
									onClick={ctx.pickUp}
									disabled={ctx.pickingUp}
								>
									{ctx.pickingUp && <Loader2 className="animate-spin" />}
									I've installed it
								</Button>
							</div>
							<p className="text-sm text-muted-foreground">
								Installed it from GitHub's own pages? Use{" "}
								<span className="text-foreground">I've installed it</span> and
								LogiStack picks up the newest installation.
							</p>
						</>
					)}
					{w.error("appName") && (
						<p className="text-xs text-bad-text" aria-live="polite">
							{w.error("appName")}
						</p>
					)}
				</div>
			),
		},
		{
			id: "test",
			title: "Test the connection",
			description: "LogiStack signs in as the app and lists what it can see.",
			when: is("github"),
			testKeys: ["kind"],
			test: () =>
				gh
					? integrations.git.testSaved(gh.id)
					: Promise.resolve({ ok: false, message: "Create the app first" }),
			render: (w) => (
				<TestPanel
					w={w}
					idle={
						<>
							We'll list the repositories{" "}
							<span className="text-foreground">{gh?.name}</span> is installed
							on.
						</>
					}
				/>
			),
		},
		{
			id: "done",
			title: "Done",
			description: "Pick its repositories when you create a service.",
			when: is("github"),
			render: (w) => (
				<Summary
					w={w}
					sections={[
						{
							stepId: "app",
							title: "GitHub App",
							rows: [
								{ label: "Name", value: gh?.name ?? "" },
								...(gh?.appUrl
									? [
											{
												label: "On GitHub",
												value: (
													<a
														href={gh.appUrl}
														target="_blank"
														rel="noreferrer"
														className="underline-offset-4 hover:underline"
													>
														{gh.appUrl.replace("https://", "")}
													</a>
												),
											},
										]
									: []),
								{
									label: "Webhook",
									value: gh?.webhookUrl ? (
										<CopyField value={gh.webhookUrl} label="Copy webhook URL" />
									) : (
										"Set up by the app"
									),
								},
							],
						},
					]}
				/>
			),
		},

		// Token and SSH providers.
		{
			id: "credentials",
			title: "Credentials",
			description:
				"Stored encrypted. LogiStack uses them to list repositories, read code and register push webhooks.",
			when: is("gitlab", "gitea", "bitbucket", "generic"),
			schema: (v) => {
				if (v.kind === "gitlab")
					return z.object({
						baseUrl: httpsUrl.or(z.literal("")),
						token: token("access token"),
					});
				if (v.kind === "gitea")
					return z.object({ baseUrl: httpsUrl, token: token("access token") });
				if (v.kind === "bitbucket")
					return z.object({
						workspace: z
							.string()
							.trim()
							.regex(/^[\w.-]+$/, "Use the workspace slug, like acme-retail."),
						accessToken: token("access token"),
					});
				return z.object({
					sshKeyId: z.string().min(1, "Choose or generate a deploy key."),
					repoUrl: z
						.string()
						.trim()
						.regex(
							SSH_URL,
							"Use an SSH URL like git@git.example.com:acme/web.git",
						),
				});
			},
			render: (w) => <CredentialsStep w={w} />,
		},
		{
			id: "check",
			title: "Test the connection",
			description: "Nothing is saved until the test passes and you confirm.",
			when: is("gitlab", "gitea", "bitbucket", "generic"),
			testKeys: [
				"kind",
				"baseUrl",
				"token",
				"workspace",
				"accessToken",
				"repoUrl",
				"sshKeyId",
				"knownHosts",
			],
			test: (v) => integrations.git.test(toConnect(v)),
			render: (w) => (
				<TestPanel
					w={w}
					idle={
						w.values.kind === "generic" ? (
							<>
								We'll run{" "}
								<span className="font-mono text-xs text-foreground">
									git ls-remote
								</span>{" "}
								on{" "}
								<span className="font-mono text-xs text-foreground">
									{sshLabel(w.values.repoUrl)}
								</span>{" "}
								with the deploy key.
							</>
						) : (
							<>
								We'll list the repositories the token can see on{" "}
								<span className="text-foreground">{derivedName(w.values)}</span>
								.
							</>
						)
					}
				/>
			),
		},
		{
			id: "name",
			title: "Name it",
			description:
				"How this connection appears when you pick a source for a service.",
			when: is("gitlab", "gitea", "bitbucket", "generic"),
			schema: z.object({
				name: z.string().trim().max(100, "Up to 100 characters."),
			}),
			render: (w) => (
				<Field
					id="wz-name"
					label="Name"
					optional
					error={w.error("name")}
					hint={`Defaults to “${derivedName(w.values)}”.`}
				>
					<Input
						{...w.bind("name")}
						placeholder={derivedName(w.values)}
						autoComplete="off"
						autoFocus
					/>
				</Field>
			),
		},
		{
			id: "review",
			title: "Review",
			description:
				"Connect it, then pick its repositories when you create a service.",
			when: is("gitlab", "gitea", "bitbucket", "generic"),
			render: (w) => {
				const v = w.values;
				const where =
					v.kind === "generic"
						? { label: "Repository", value: sshLabel(v.repoUrl) }
						: v.kind === "bitbucket"
							? { label: "Workspace", value: v.workspace.trim() }
							: { label: "Instance", value: trimUrl(v.baseUrl || GITLAB) };
				return (
					<Summary
						w={w}
						sections={[
							{
								stepId: "credentials",
								title: GIT_KIND[v.kind].label,
								rows: [
									{
										label: where.label,
										value: (
											<span className="font-mono text-xs">{where.value}</span>
										),
									},
									{
										label: v.kind === "generic" ? "Deploy key" : "Token",
										value:
											v.kind === "generic"
												? "Selected and tested"
												: "Tested, stored encrypted",
									},
									{
										label: "Webhooks",
										value:
											v.kind === "generic"
												? "None: deploy from CI or by hand"
												: "Registered on each repository you deploy",
									},
								],
							},
							{
								stepId: "name",
								title: "Name",
								rows: [
									{ label: "Name", value: v.name.trim() || derivedName(v) },
								],
							},
						]}
					/>
				);
			},
		},
	];
}

function CreateOnGitHub({
	w,
	start,
}: {
	w: WizardApi<V>;
	start: (v: V) => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	return (
		<div className="flex flex-wrap items-center gap-3">
			<Button
				type="button"
				disabled={pending}
				onClick={() => {
					setPending(true);
					start(w.values).catch((e: unknown) => {
						setPending(false);
						toast.error("Couldn't start the GitHub flow", {
							description: e instanceof Error ? e.message : String(e),
						});
					});
				}}
			>
				{pending ? (
					<Loader2 className="animate-spin" />
				) : (
					<GIT_KIND.github.icon data-icon="inline-start" />
				)}
				Create on GitHub
			</Button>
			<span className="text-xs text-muted-foreground">
				Opens github.com
				{w.values.account === "organization" && w.values.organization
					? ` as ${w.values.organization.trim()}`
					: ""}
				.
			</span>
		</div>
	);
}

function CredentialsStep({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	if (v.kind === "gitlab" || v.kind === "gitea") {
		const base = trimUrl(v.baseUrl);
		const valid = httpsUrl.safeParse(base).success;
		const tokenPage =
			v.kind === "gitlab"
				? `${base}/-/user_settings/personal_access_tokens?name=LogiStack&scopes=api`
				: `${base}/user/settings/applications`;
		return (
			<div className="grid gap-5">
				<Field
					id="wz-baseUrl"
					label={v.kind === "gitlab" ? "GitLab URL" : "Instance URL"}
					error={w.error("baseUrl")}
					hint={
						v.kind === "gitlab"
							? "gitlab.com, or your own instance like https://gitlab.example.com."
							: "Like https://git.example.com. Forgejo works the same way."
					}
				>
					<Input
						{...w.bind("baseUrl")}
						placeholder={
							v.kind === "gitlab" ? GITLAB : "https://git.example.com"
						}
						inputMode="url"
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
						autoFocus
					/>
				</Field>
				<Instructions
					href={valid ? tokenPage : undefined}
					link={`Create a token on ${hostOf(base)}`}
				>
					{v.kind === "gitlab" ? (
						<>
							<p>
								Create a <strong>personal</strong> or <strong>group</strong>{" "}
								access token with the <strong>api</strong> scope.
							</p>
							<p>
								LogiStack needs <strong>api</strong> to register push webhooks;{" "}
								read_api can list repositories but not create webhooks. OAuth
								applications aren't supported.
							</p>
						</>
					) : (
						<p>
							Under <strong>Settings › Applications</strong>, generate a token
							with <strong>repository: read and write</strong> (write registers
							webhooks) and <strong>user: read</strong>.
						</p>
					)}
				</Instructions>
				<Field id="wz-token" label="Access token" error={w.error("token")}>
					<Input
						{...w.bind("token")}
						type="password"
						autoComplete="off"
						spellCheck={false}
						className="font-mono"
						placeholder={v.kind === "gitlab" ? "glpat-…" : undefined}
					/>
				</Field>
			</div>
		);
	}
	if (v.kind === "bitbucket") {
		const ws = v.workspace.trim();
		return (
			<div className="grid gap-5">
				<Field
					id="wz-workspace"
					label="Workspace"
					error={w.error("workspace")}
					hint="The slug in bitbucket.org/<workspace>."
				>
					<Input
						{...w.bind("workspace")}
						placeholder="acme-retail"
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
						autoFocus
					/>
				</Field>
				<Instructions
					href={
						ws
							? `https://bitbucket.org/${ws}/workspace/settings/access-tokens`
							: undefined
					}
					link="Create a workspace token"
				>
					<p>
						Create a <strong>workspace</strong> or <strong>repository</strong>{" "}
						access token with <strong>Repositories: Read</strong> and{" "}
						<strong>Webhooks: Read and write</strong>.
					</p>
				</Instructions>
				<Field
					id="wz-accessToken"
					label="Access token"
					error={w.error("accessToken")}
				>
					<Input
						{...w.bind("accessToken")}
						type="password"
						autoComplete="off"
						spellCheck={false}
						className="font-mono"
					/>
				</Field>
			</div>
		);
	}
	return <SshStep w={w} />;
}

const NEW_KEY = "__new";

function SshStep({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	const { data: keys = [] } = useQuery(sshKeysQuery);
	const createKey = useCreateSshKey();
	const [keyName, setKeyName] = useState("");
	const [generating, setGenerating] = useState(false);
	const selected = keys.find((k) => k.id === v.sshKeyId);
	const showGenerate = generating || (keys.length === 0 && !selected);

	return (
		<div className="grid gap-5">
			<Field
				id="wz-sshKeyId"
				label="Deploy key"
				error={w.error("sshKeyId")}
				hint="LogiStack keeps the private key encrypted and never shows it."
			>
				{keys.length > 0 && (
					<Select
						value={generating ? NEW_KEY : v.sshKeyId}
						onValueChange={(id) => {
							setGenerating(id === NEW_KEY);
							w.set("sshKeyId", id === NEW_KEY ? "" : id);
						}}
					>
						<SelectTrigger
							id="wz-sshKeyId"
							className="w-full"
							aria-invalid={w.error("sshKeyId") ? true : undefined}
						>
							<SelectValue placeholder="Choose a key" />
						</SelectTrigger>
						<SelectContent>
							{keys.map((k) => (
								<SelectItem key={k.id} value={k.id}>
									{k.name}
									<span className="font-mono text-xs text-muted-foreground">
										{k.fingerprint.slice(0, 19)}…
									</span>
								</SelectItem>
							))}
							<SelectItem value={NEW_KEY}>Generate a new key</SelectItem>
						</SelectContent>
					</Select>
				)}
				{showGenerate && (
					<div className="flex gap-2">
						<Input
							id={keys.length ? "wz-keyName" : "wz-sshKeyId"}
							aria-label="New key name"
							value={keyName}
							onChange={(e) => setKeyName(e.target.value)}
							placeholder="ops-deploy"
							autoComplete="off"
							onKeyDown={(e) => {
								if (e.key === "Enter") e.preventDefault();
							}}
						/>
						<Button
							type="button"
							variant="outline"
							disabled={createKey.isPending || !keyName.trim()}
							onClick={() =>
								createKey.mutate(keyName.trim(), {
									onSuccess: (key) => {
										setGenerating(false);
										setKeyName("");
										w.set("sshKeyId", key.id);
									},
									onError: (e) =>
										toast.error("Couldn't generate the key", {
											description: e.message,
										}),
								})
							}
						>
							{createKey.isPending && <Loader2 className="animate-spin" />}
							Generate ed25519 key
						</Button>
					</div>
				)}
			</Field>
			{selected && !generating && (
				<div className="t-reveal grid gap-2">
					<p className="text-sm text-muted-foreground">
						Add this public key as a{" "}
						<span className="text-foreground">deploy key</span> with read access
						in the repository's settings.
					</p>
					<CopyField value={selected.publicKey} label="Copy public key" wrap />
				</div>
			)}
			<Field
				id="wz-repoUrl"
				label="Repository URL"
				error={w.error("repoUrl")}
				hint="SSH only, like git@git.example.com:acme/web.git or ssh://git@host:2222/acme/web.git."
			>
				<Input
					{...w.bind("repoUrl")}
					placeholder="git@git.example.com:acme/web.git"
					autoCapitalize="none"
					spellCheck={false}
					className="font-mono"
				/>
			</Field>
			<Field
				id="wz-knownHosts"
				label="known_hosts"
				optional
				hint="Recommended. Paste the output of ssh-keyscan for the host; without it, LogiStack accepts whatever key the host presents."
			>
				<Textarea
					{...w.bind("knownHosts")}
					rows={3}
					spellCheck={false}
					placeholder="git.example.com ssh-ed25519 AAAAC3Nza…"
					className="font-mono text-xs leading-5"
				/>
			</Field>
		</div>
	);
}

/** Submits GitHub's manifest form: a real POST, so the browser navigates to github.com. */
function postManifest(action: string, manifest: unknown) {
	const form = document.createElement("form");
	form.method = "post";
	form.action = action;
	const input = document.createElement("input");
	input.type = "hidden";
	input.name = "manifest";
	input.value = JSON.stringify(manifest);
	form.append(input);
	document.body.append(form);
	form.submit();
}

function ConnectProvider() {
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const providers = useQuery({
		...gitProvidersQuery,
		enabled: Boolean(search.provider),
	});
	const gh = providers.data?.find(
		(p) => p.id === search.provider && p.kind === "github",
	);
	const create = useCreateGitProvider();
	const pickUp = usePickUpInstallation();

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({
				search: (s) => ({ ...s, step: id, error: undefined }),
				replace,
			}),
		[navigate],
	);

	const startManifest = useCallback(
		async (v: V) => {
			const res = await integrations.git.githubManifest({
				name: v.appName.trim(),
				...(v.account === "organization"
					? { organization: v.organization.trim() }
					: {}),
			});
			// The mock can't round-trip through github.com; pretend GitHub redirected back.
			if (isMock) {
				await providers.refetch();
				await navigate({
					search: { kind: "github", provider: res.providerId, step: "install" },
				});
				return;
			}
			postManifest(res.action, res.manifest);
		},
		[navigate, providers],
	);

	const steps = useMemo(
		() =>
			buildSteps({
				gh,
				urlError: search.error,
				urlStep: search.step,
				startManifest,
				pickingUp: pickUp.isPending,
				pickUp: async () => {
					if (!gh) return;
					try {
						await pickUp.mutateAsync(gh.id);
						await navigate({
							search: (s) => ({ ...s, step: "test", error: undefined }),
						});
					} catch (e) {
						toast.error(
							e instanceof ApiError && e.status === 409
								? "No installation found yet"
								: "Couldn't check the installation",
							{
								description:
									e instanceof ApiError && e.status === 409
										? "Install the app on GitHub first, then try again."
										: e instanceof Error
											? e.message
											: String(e),
							},
						);
					}
				},
			}),
		[gh, search.error, search.step, startManifest, pickUp, navigate],
	);

	// Deep links into the GitHub steps must wait for the provider, or the wizard clamps them to the start.
	if (search.provider && providers.isPending) return null;

	const id = `git-provider:${search.provider ?? "new"}`;
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Connect a Git provider"
				description="Build and deploy on every push from the repositories you choose."
			/>
			<Wizard
				key={id}
				id={id}
				steps={steps}
				defaultValues={{
					...DEFAULTS,
					kind: search.kind ?? DEFAULTS.kind,
					appName: gh?.name ?? "",
				}}
				secretKeys={SECRETS}
				step={search.step}
				onStepChange={onStepChange}
				finishLabel={search.provider ? "Done" : "Connect provider"}
				onComplete={async (v) => {
					if (v.kind === "github") {
						toast.success(`${gh?.name ?? "GitHub"} is connected`);
					} else {
						const name = v.name.trim() || derivedName(v);
						await create.mutateAsync({ name, provider: toConnect(v) });
						toast.success(`${name} is connected`, {
							description: "Pick its repositories when you create a service.",
						});
					}
					await navigate({ to: "/integrations/git" });
				}}
			/>
		</Page>
	);
}
