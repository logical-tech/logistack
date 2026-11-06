import {
	type BuildConfig,
	databaseIcon,
	type ResourceProfiles,
	ServiceSpec as SpecSchema,
} from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	Box,
	ChevronDown,
	ChevronsUpDown,
	Container,
	Database,
	GitBranch,
	Globe,
	HardDrive,
	Layers,
	Link2Off,
	Lock,
	Network,
	PenLine,
	Server,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { brandMark } from "@/components/brand-icon";
import { Field } from "@/components/field";
import { GIT_KIND } from "@/components/integration-kinds";
import { Page, PageHeader } from "@/components/page-header";
import {
	type HostSettings,
	MountRows,
	PortRows,
	ProcessFields,
	withRoutedPort,
} from "@/components/service/host-settings";
import {
	LoadBalancerForm,
	targetSuggestions,
} from "@/components/service/load-balancer-form";
import {
	ReleaseCommandFields,
	type ReleaseSettings,
} from "@/components/service/release-commands";
import {
	limitsLabel,
	limitsOf,
	ResourceProfileSelect,
	UNLIMITED,
} from "@/components/service/resource-profile-select";
import {
	STORAGE_DEFAULTS,
	type StorageFields,
	storageDomains,
	storageSteps,
	storageSummary,
} from "@/components/storage/wizard-steps";
import { TemplatesTile } from "@/components/templates/templates-tile";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup, Summary, TestPanel } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { ApiError } from "@/lib/api";
import { useResourceProfiles } from "@/lib/api/access";
import { instanceStatusQuery } from "@/lib/api/instance";
import {
	branchesQuery,
	type GitProvider,
	type GitRepo,
	gitProvidersQuery,
	integrations,
	reposQuery,
	type WebhookOutcome,
} from "@/lib/api/integrations";
import { projectQuery } from "@/lib/api/projects";
import {
	checkSource,
	servicesQuery,
	useCreateService,
} from "@/lib/api/services";
import {
	type StackId,
	useCreateComposeStack,
	useCreateGitStack,
} from "@/lib/api/stacks";
import type {
	BuildType,
	DatabaseEngine,
	Environment,
	ServiceId,
	ServiceSpec,
} from "@/lib/api/types";
import { stepParam } from "@/lib/search";
import { STORAGE_ENGINES } from "@/lib/storage-engines";
import { cn } from "@/lib/utils";
import {
	LB_DEFAULTS,
	type LbSettings,
	lbIssue,
	loadBalancerConfig,
	WEBSERVERS,
	type WebserverKind,
	webserverKinds,
	webserverMarker,
	webserverMounts,
} from "@/lib/webservers";

export const Route = createFileRoute("/_app/projects/$projectId/services/new")({
	validateSearch: z.object({
		env: z.string().startsWith("env_").optional().catch(undefined),
		step: stepParam,
	}),
	staticData: { crumb: "New service" },
	component: NewService,
});

type SourceKind =
	| "git"
	| "image"
	| "database"
	| "compose"
	| "storage"
	| "webserver";

type V = StorageFields & {
	kind: SourceKind;
	name: string;
	/** A connected Git provider, or "" for a public repository over HTTPS. */
	providerId: string;
	repository: string;
	branch: string;
	path: string;
	/** Globs or directories, one per line; empty builds on every push. */
	watchPaths: string;
	build: Exclude<BuildType, "image">;
	port: string;
	image: string;
	engine: DatabaseEngine;
	version: string;
	composeYaml: string;
	/** A pasted compose file, or one read from a connected repository and re-synced on push. */
	composeFrom: "paste" | "git";
	composePath: string;
	webserver: WebserverKind;
	/** Load balancer form; the config is generated from it. */
	lb: LbSettings;
	domainMode: "generated" | "custom" | "none";
	hostname: string;
	https: boolean;
	/** Image sources only: published ports, bind mounts, user, capabilities, restart. */
	host: HostSettings;
	/** Applications: commands run on the new image around each rollout. */
	release: ReleaseSettings;
	/** A profile name or UNLIMITED; empty follows the organization default. */
	resourceProfile: string;
};

const DEFAULTS: V = {
	kind: "git",
	name: "",
	providerId: "",
	repository: "",
	branch: "main",
	path: "/",
	watchPaths: "",
	build: "dockerfile",
	port: "3000",
	image: "",
	engine: "postgres",
	version: "17",
	composeYaml: "",
	composeFrom: "paste",
	composePath: "docker-compose.yml",
	webserver: "nginx",
	lb: LB_DEFAULTS,
	domainMode: "generated",
	hostname: "",
	https: true,
	host: { ports: [] },
	release: {},
	resourceProfile: "",
	...STORAGE_DEFAULTS,
};

const ENGINES: Record<
	DatabaseEngine,
	{ label: string; versions: string[]; port: number }
> = {
	postgres: { label: "PostgreSQL", versions: ["17", "16", "15"], port: 5432 },
	mysql: { label: "MySQL", versions: ["8.4", "8.0"], port: 3306 },
	mariadb: {
		label: "MariaDB",
		versions: ["11.8", "11.4", "10.11"],
		port: 3306,
	},
	mongo: { label: "MongoDB", versions: ["8.0", "7.0"], port: 27017 },
	redis: { label: "Redis", versions: ["8.2", "7.4"], port: 6379 },
	libsql: { label: "libSQL", versions: ["0.24.33"], port: 8080 },
};

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/** Name the user typed, or one derived from the source. */
function serviceName(v: V) {
	if (v.name.trim()) return slug(v.name);
	if (v.kind === "git")
		return (
			slug(
				v.repository
					.split("/")
					.pop()
					?.replace(/\.git$/, "") ?? "",
			) || "app"
		);
	if (v.kind === "image")
		return slug(v.image.split("/").pop()?.split(":")[0] ?? "") || "app";
	if (v.kind === "database") return v.engine;
	if (v.kind === "storage") return "storage";
	if (v.kind === "webserver")
		return v.webserver === "haproxy" ? "lb" : v.webserver;
	return "stack";
}

const normalizeRepo = (r: string) =>
	r
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\.git$/, "");

/** The worker clones public repositories over https only. */
const httpsRepo = (r: string) => `https://${normalizeRepo(r)}`;

const watchPathList = (text: string) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

/** Provider sources name the repository as the provider does (`acme/web`); public ones by host. */
const repoLabel = (v: V) =>
	v.providerId ? v.repository : normalizeRepo(v.repository);

function gitSource(v: V) {
	return {
		type: "git" as const,
		...(v.providerId
			? { gitProviderId: v.providerId, repository: v.repository }
			: { repository: httpsRepo(v.repository) }),
		branch: v.branch.trim(),
		path: v.path.trim(),
	};
}

const portSchema = z
	.string()
	.regex(/^\d+$/, "Use a number.")
	.refine(
		(p) => Number(p) >= 1 && Number(p) <= 65535,
		"Ports go from 1 to 65535.",
	);

const nameSchema = z
	.string()
	.trim()
	.regex(
		/^$|^[a-zA-Z0-9][a-zA-Z0-9 -]{0,39}$/,
		"Letters, numbers, spaces and dashes; up to 40.",
	);

function buildSteps(
	env: Environment,
	generatedBase: string,
	providers: GitProvider[],
	suggestions: string[],
): WizardStep<V>[] {
	const providerName = (id: string) =>
		providers.find((p) => p.id === id)?.name ?? "the provider";
	// The server appends the last six characters of the service id.
	const generated = (v: V) => `${serviceName(v)}-xxxxxx.${generatedBase}`;
	return [
		{
			id: "source",
			title: "Choose a source",
			description:
				"Where this service comes from. You can change the build settings later.",
			render: (w) => (
				<ChoiceGroup
					label="Source"
					footer={
						<TemplatesTile projectId={env.projectId} environmentId={env.id} />
					}
					value={w.values.kind}
					onChange={(k) => {
						w.set("kind", k);
						if (k === "image") w.set("port", "80");
						if (k === "git") w.set("port", "3000");
						if (k === "webserver")
							w.set("port", String(WEBSERVERS[w.values.webserver].port));
					}}
					choices={[
						{
							value: "git",
							title: "Git repository",
							description:
								"Build on every push with a Dockerfile, Railpack or as a static site.",
							icon: GitBranch,
						},
						{
							value: "image",
							title: "Docker image",
							description:
								"Run a published image from Docker Hub, GHCR or any registry.",
							icon: Container,
						},
						{
							value: "database",
							title: "Database",
							description:
								"PostgreSQL, MySQL, MariaDB, MongoDB, Redis or libSQL with backups.",
							icon: Database,
						},
						{
							value: "compose",
							title: "Docker Compose",
							description:
								"Paste a compose file, or follow one in a repository, and deploy it as one stack.",
							icon: Layers,
						},
						{
							value: "storage",
							title: "Object storage",
							description:
								"An S3-compatible server with buckets, scoped keys and share links.",
							icon: HardDrive,
						},
						{
							value: "webserver",
							title: "Web server",
							description:
								"Nginx, Caddy, Apache or a load balancer, with its config editable in the browser.",
							icon: Server,
						},
					]}
				/>
			),
		},
		{
			id: "configure",
			title: "Configure",
			description: `Settings for the new service in ${env.name}.`,
			when: (v) => v.kind !== "storage",
			schema: (v) => {
				const base = { name: nameSchema };
				if (v.kind === "git") {
					return z.object({
						...base,
						repository: v.providerId
							? z.string().min(1, "Choose a repository.")
							: z
									.string()
									.trim()
									.min(1, "Enter a repository.")
									.regex(
										/^(https:\/\/)?[\w.-]+\.[a-z]{2,}\/[\w.-]+\/[\w.-]+(\.git)?\/?$/i,
										"Use an https URL like github.com/acme/web. For SSH, connect the host as a Git provider.",
									),
						branch: z.string().trim().min(1, "Enter a branch."),
						path: z.string().trim().startsWith("/", "Paths start with /."),
						watchPaths: z
							.string()
							.refine((t) => watchPathList(t).length <= 50, "Up to 50 paths.")
							.refine(
								(t) => watchPathList(t).every((l) => l.length <= 200),
								"Each path is up to 200 characters.",
							),
						port: portSchema,
					});
				}
				if (v.kind === "image") {
					return z.object({
						...base,
						image: z
							.string()
							.trim()
							.min(1, "Enter an image.")
							.regex(
								/^[a-z0-9][\w./:@-]*$/i,
								"Use a reference like nginx:1.29 or ghcr.io/acme/web:2.1",
							),
						port: portSchema,
						host: z.custom<HostSettings>(
							(h) => hostIssues(h as HostSettings).length === 0,
							"Fix the advanced settings below.",
						),
					});
				}
				if (v.kind === "compose" && v.composeFrom === "git") {
					return z.object({
						...base,
						repository: z.string().min(1, "Choose a repository."),
						branch: z.string().trim().min(1, "Enter a branch."),
						composePath: z
							.string()
							.trim()
							.min(1, "Enter the path of the compose file.")
							.refine(
								(p) =>
									!p.startsWith("/") &&
									p.split("/").every((s) => s && s !== ".."),
								"A path inside the repository, like deploy/compose.yaml.",
							),
					});
				}
				if (v.kind === "compose") {
					return z.object({
						...base,
						composeYaml: z
							.string()
							.refine(
								(y) => /^\s*services\s*:/m.test(y),
								"A compose file needs a top-level services: key.",
							),
					});
				}
				if (v.kind === "webserver" && v.webserver === "haproxy") {
					return z.object({
						...base,
						lb: z.custom<LbSettings>(
							(s) => !lbIssue(s as LbSettings),
							"Fix the load balancer settings.",
						),
					});
				}
				return z.object(base);
			},
			render: (w) => (
				<ConfigureStep w={w} providers={providers} suggestions={suggestions} />
			),
		},
		...storageSteps<V>({
			envName: env.name,
			slug: serviceName,
			generated,
			nameField: (w) => <NameField w={w} />,
		}),
		{
			id: "test",
			title: "Test the source",
			description:
				"LogiStack checks it can reach the source before anything is created.",
			when: (v) =>
				v.kind === "git" ||
				v.kind === "image" ||
				(v.kind === "compose" && v.composeFrom === "git"),
			testKeys: [
				"kind",
				"composeFrom",
				"providerId",
				"repository",
				"branch",
				"path",
				"image",
			],
			test: (v) =>
				(v.kind === "git" || v.kind === "compose") && v.providerId
					? integrations.git.check(v.providerId, {
							repository: v.repository,
							branch: v.branch.trim(),
						})
					: checkSource(
							v.kind === "git"
								? gitSource(v)
								: { type: "image", image: v.image.trim() },
						),
			render: (w) => (
				<div className="grid gap-4">
					<p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
						{w.values.kind === "image" ? (
							<Container className="size-4 shrink-0" aria-hidden />
						) : (
							<GitBranch className="size-4 shrink-0" aria-hidden />
						)}
						<span className="truncate font-mono text-foreground">
							{w.values.kind === "compose"
								? `${w.values.repository}@${w.values.branch} ${w.values.composePath}`
								: w.values.kind === "git"
									? `${repoLabel(w.values)}@${w.values.branch}${w.values.path === "/" ? "" : ` ${w.values.path}`}`
									: w.values.image}
						</span>
					</p>
					<TestPanel
						w={w}
						idle={
							w.values.kind !== "image" ? (
								<>
									We'll read{" "}
									<span className="font-mono text-xs text-foreground">
										{repoLabel(w.values)}@{w.values.branch}
									</span>{" "}
									{w.values.providerId
										? `with ${providerName(w.values.providerId)}.`
										: "over HTTPS, without credentials."}
								</>
							) : (
								<>
									We'll fetch the manifest for{" "}
									<span className="font-mono text-xs text-foreground">
										{w.values.image}
									</span>
									.
								</>
							)
						}
					/>
				</div>
			),
		},
		{
			id: "domain",
			title: "Domain",
			description: "How people reach this service from the internet.",
			// A compose stack's containers get their domains from the stack page.
			when: (v) =>
				v.kind !== "database" && v.kind !== "storage" && v.kind !== "compose",
			schema: (v) =>
				z.object({
					hostname:
						v.domainMode === "custom"
							? z
									.string()
									.trim()
									.toLowerCase()
									.regex(
										/^([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/,
										"Use a hostname like shop.example.com",
									)
							: z.string(),
				}),
			render: (w) => (
				<div className="grid gap-6">
					<ChoiceGroup
						label="Domain"
						value={w.values.domainMode}
						onChange={(m) => w.set("domainMode", m)}
						columns={1}
						choices={[
							{
								value: "generated",
								title: "Generated hostname",
								description: generated(w.values),
								icon: Globe,
							},
							{
								value: "custom",
								title: "Custom hostname",
								description:
									"Your own domain. Point a CNAME or A record at this server.",
								icon: PenLine,
							},
							{
								value: "none",
								title: "No public domain",
								description:
									"Reachable only from other services on the internal network.",
								icon: Link2Off,
							},
						]}
					/>
					{w.values.domainMode === "custom" && (
						<Field
							id="wz-hostname"
							label="Hostname"
							error={w.error("hostname")}
						>
							<Input
								{...w.bind("hostname")}
								placeholder="shop.example.com"
								autoCapitalize="none"
								spellCheck={false}
								className="font-mono"
								autoFocus
							/>
						</Field>
					)}
					{w.values.domainMode !== "none" && (
						<label
							htmlFor="wz-https"
							className="flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-muted/40"
						>
							<span>
								<span className="block font-medium">HTTPS</span>
								<span className="text-muted-foreground">
									Certificate from Let's Encrypt, HTTP redirects to HTTPS.
								</span>
							</span>
							<Switch
								id="wz-https"
								checked={w.values.https}
								onCheckedChange={(c) => w.set("https", c)}
							/>
						</label>
					)}
				</div>
			),
		},
		{
			id: "storage-review",
			title: "Review",
			description:
				"Nothing is created until you confirm. The engine starts right after, with fresh root credentials.",
			when: (v) => v.kind === "storage",
			render: (w) => (
				<Summary
					w={w}
					sections={[
						{
							stepId: "engine",
							title: "Object storage",
							rows: [
								{ label: "Name", value: serviceName(w.values) },
								{ label: "Environment", value: env.name },
								{
									label: "Engine",
									value: `${STORAGE_ENGINES[w.values.storageEngine].label} ${STORAGE_ENGINES[w.values.storageEngine].version}`,
								},
							],
						},
						storageSummary(w.values, generated),
					]}
				/>
			),
		},
		{
			id: "review",
			title: "Review",
			description:
				"Nothing is created until you confirm. The first deployment starts right after.",
			when: (v) => v.kind !== "storage",
			render: (w) => {
				const v = w.values;
				const source =
					v.kind === "git"
						? [
								{
									label: "Provider",
									value: v.providerId
										? providerName(v.providerId)
										: "Public repository over HTTPS",
								},
								{
									label: "Repository",
									value: (
										<span className="font-mono text-xs">{repoLabel(v)}</span>
									),
								},
								{ label: "Branch", value: v.branch },
								{
									label: "Root",
									value: <span className="font-mono text-xs">{v.path}</span>,
								},
								{
									label: "Watch paths",
									value: watchPathList(v.watchPaths).length ? (
										<span className="grid font-mono text-xs">
											{watchPathList(v.watchPaths).map((p) => (
												<span key={p}>{p}</span>
											))}
										</span>
									) : (
										"Every push builds"
									),
								},
								{ label: "Build", value: BUILD_LABEL[v.build] },
								{ label: "Port", value: v.port },
								...releaseRows(v.release),
							]
						: v.kind === "image"
							? [
									{
										label: "Image",
										value: <span className="font-mono text-xs">{v.image}</span>,
									},
									{ label: "Port", value: v.port },
									...hostRows(v.host),
									...releaseRows(v.release),
								]
							: v.kind === "database"
								? [
										{
											label: "Engine",
											value: `${ENGINES[v.engine].label} ${v.version}`,
										},
									]
								: v.kind === "webserver"
									? webserverRows(v)
									: v.composeFrom === "git"
										? [
												{
													label: "Provider",
													value: providerName(v.providerId),
												},
												{
													label: "Repository",
													value: (
														<span className="font-mono text-xs">
															{v.repository}
														</span>
													),
												},
												{ label: "Branch", value: v.branch },
												{
													label: "Compose file",
													value: (
														<span className="font-mono text-xs">
															{v.composePath}
														</span>
													),
												},
												{ label: "Sync", value: "Every push to the branch" },
											]
										: [
												{
													label: "Compose",
													value: `${v.composeYaml.split("\n").length} lines`,
												},
											];
				return (
					<Summary
						w={w}
						sections={[
							{
								stepId: "configure",
								title: "Service",
								rows: [
									{ label: "Name", value: serviceName(v) },
									{ label: "Environment", value: env.name },
									...source,
									...(v.kind === "compose"
										? []
										: [
												{ label: "Resources", value: <ProfileSummary v={v} /> },
											]),
								],
							},
							...(v.kind === "database"
								? []
								: [
										{
											stepId: "domain",
											title: "Domain",
											rows: [
												{
													label: "Hostname",
													value:
														v.domainMode === "none" ? (
															"Internal only"
														) : (
															<span className="font-mono text-xs">
																{v.https ? "https://" : "http://"}
																{v.domainMode === "custom"
																	? v.hostname
																	: generated(v)}
															</span>
														),
												},
											],
										},
									]),
						]}
					/>
				);
			},
		},
	];
}

const BUILD_LABEL: Record<V["build"], string> = {
	dockerfile: "Dockerfile",
	railpack: "Railpack (no Dockerfile needed)",
	static: "Static site",
};

const PUBLIC = "__public";

function RepoPicker({ w }: { w: WizardApi<V> }) {
	const { data: repos, isPending } = useQuery(reposQuery(w.values.providerId));
	const [open, setOpen] = useState(false);
	const value = w.values.repository;
	const pick = (r: GitRepo) => {
		w.set("repository", r.fullName);
		w.set("branch", r.defaultBranch ?? "main");
		setOpen(false);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					id="wz-repository"
					type="button"
					variant="outline"
					role="combobox"
					aria-expanded={open}
					aria-invalid={w.error("repository") ? true : undefined}
					aria-describedby="wz-repository-msg"
					className="h-8 w-full justify-between font-normal"
				>
					<span
						className={cn(
							"truncate",
							value ? "font-mono text-sm" : "text-muted-foreground",
						)}
					>
						{value ||
							(isPending ? "Loading repositories…" : "Choose a repository")}
					</span>
					<ChevronsUpDown className="opacity-50" aria-hidden />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-(--radix-popover-trigger-width) p-0"
				align="start"
			>
				<Command>
					<CommandInput placeholder="Search repositories" />
					<CommandList>
						<CommandEmpty>
							{isPending ? "Loading…" : "No repository matches."}
						</CommandEmpty>
						<CommandGroup>
							{repos?.map((r) => (
								<CommandItem
									key={r.fullName}
									value={r.fullName}
									data-checked={r.fullName === value}
									onSelect={() => pick(r)}
								>
									<span className="min-w-0 flex-1 truncate font-mono text-xs">
										{r.fullName}
									</span>
									{r.private && (
										<Lock
											className="size-3.5 text-muted-foreground"
											aria-label="Private"
										/>
									)}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function BranchField({ w }: { w: WizardApi<V> }) {
	const { providerId, repository, branch } = w.values;
	const { data: branches } = useQuery(branchesQuery(providerId, repository));
	// Generic SSH remotes list no branches: the branch is typed by hand.
	const choices = branches?.length
		? [...new Set([branch, ...branches].filter(Boolean))]
		: null;
	return (
		<Field id="wz-branch" label="Branch" error={w.error("branch")}>
			{choices ? (
				<Select value={branch} onValueChange={(b) => w.set("branch", b)}>
					<SelectTrigger id="wz-branch" className="w-full font-mono">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{choices.map((b) => (
							<SelectItem key={b} value={b} className="font-mono">
								{b}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : (
				<Input {...w.bind("branch")} className="font-mono" spellCheck={false} />
			)}
		</Field>
	);
}

function NameField({ w }: { w: WizardApi<V> }) {
	const fallback = serviceName({ ...w.values, name: "" });
	return (
		<Field
			id="wz-name"
			label="Service name"
			optional
			error={w.error("name")}
			hint={`Defaults to “${fallback}”.`}
		>
			<Input {...w.bind("name")} placeholder={fallback} />
		</Field>
	);
}

/** The profile the wizard will copy: the one picked, else the organization default. */
function chosenProfile(v: V, rp: ResourceProfiles | undefined) {
	const name = v.resourceProfile || rp?.defaultProfile;
	return rp?.profiles.find((p) => p.name === name);
}

function ProfileSummary({ v }: { v: V }) {
	const p = chosenProfile(v, useResourceProfiles().data);
	return p ? (
		<span>
			{p.name}{" "}
			<span className="text-muted-foreground tabular-nums">
				{limitsLabel(p)}
			</span>
		</span>
	) : (
		"Unlimited"
	);
}

function ProfileField({ w }: { w: WizardApi<V> }) {
	const { data } = useResourceProfiles();
	return (
		<Field
			id="wz-resourceProfile"
			label="Resources"
			hint="Limits per replica, copied from the profile. Change them later in the service settings."
		>
			<ResourceProfileSelect
				id="wz-resourceProfile"
				value={chosenProfile(w.values, data)?.name ?? UNLIMITED}
				onChange={(name) => w.set("resourceProfile", name)}
			/>
		</Field>
	);
}

function ConfigureStep({
	w,
	providers,
	suggestions,
}: {
	w: WizardApi<V>;
	providers: GitProvider[];
	suggestions: string[];
}) {
	const v = w.values;
	const name = (
		<>
			<NameField w={w} />
			{v.kind !== "compose" && <ProfileField w={w} />}
		</>
	);
	if (v.kind === "webserver") {
		const def = WEBSERVERS[v.webserver];
		return (
			<div className="grid gap-6">
				<ChoiceGroup
					label="Server"
					value={v.webserver}
					onChange={(k) => {
						w.set("webserver", k);
						w.set("port", String(WEBSERVERS[k].port));
					}}
					columns={2}
					choices={webserverKinds.map((k) => ({
						value: k,
						title: WEBSERVERS[k].label,
						description: WEBSERVERS[k].description,
						icon: k === "haproxy" ? Network : Server,
					}))}
				/>
				{v.webserver === "haproxy" && (
					<LoadBalancerForm
						idPrefix="wz-lb-"
						value={v.lb}
						onChange={(lb) => w.set("lb", lb)}
						suggestions={suggestions}
						error={w.error("lb") ? lbIssue(v.lb) : undefined}
					/>
				)}
				{name}
				<p className="text-sm text-muted-foreground">
					{def.docroot
						? "Starts with a working default config and a volume for your files. Edit the config and upload files from the service's Files tab."
						: "The config is generated from these settings. Change them, or edit the raw config, from the service's Files tab."}
				</p>
			</div>
		);
	}
	if (v.kind === "git") {
		return (
			<div className="grid gap-4">
				{providers.length > 0 && (
					<Field id="wz-providerId" label="Git provider">
						<Select
							value={v.providerId || PUBLIC}
							onValueChange={(id) => {
								w.set("providerId", id === PUBLIC ? "" : id);
								w.set("repository", "");
							}}
						>
							<SelectTrigger id="wz-providerId" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{providers.map((p) => {
									const Icon = GIT_KIND[p.kind].icon;
									return (
										<SelectItem key={p.id} value={p.id}>
											<Icon aria-hidden />
											{p.name}
										</SelectItem>
									);
								})}
								<SelectItem value={PUBLIC}>
									<Globe aria-hidden />
									Public repository over HTTPS
								</SelectItem>
							</SelectContent>
						</Select>
					</Field>
				)}
				{v.providerId ? (
					<Field
						id="wz-repository"
						label="Repository"
						error={w.error("repository")}
					>
						<RepoPicker key={v.providerId} w={w} />
					</Field>
				) : (
					<Field
						id="wz-repository"
						label="Repository"
						error={w.error("repository")}
						hint={
							providers.length
								? "Anyone can read it; no credentials are used."
								: "Public over HTTPS. Private repositories need a connected Git provider."
						}
					>
						<Input
							{...w.bind("repository")}
							placeholder="github.com/acme/storefront"
							autoCapitalize="none"
							spellCheck={false}
							className="font-mono"
							autoFocus
						/>
					</Field>
				)}
				<div className="grid gap-4 sm:grid-cols-2">
					{v.providerId ? (
						<BranchField w={w} />
					) : (
						<Field id="wz-branch" label="Branch" error={w.error("branch")}>
							<Input
								{...w.bind("branch")}
								className="font-mono"
								spellCheck={false}
							/>
						</Field>
					)}
					<Field
						id="wz-path"
						label="Root directory"
						error={w.error("path")}
						hint="For monorepos."
					>
						<Input
							{...w.bind("path")}
							className="font-mono"
							spellCheck={false}
						/>
					</Field>
				</div>
				<Field
					id="wz-watchPaths"
					label="Watch paths"
					optional
					error={w.error("watchPaths")}
					hint="One per line, like apps/web/** or packages/ui. A push builds only when it touches one of them."
				>
					<Textarea
						{...w.bind("watchPaths")}
						rows={3}
						spellCheck={false}
						placeholder={"apps/web/**\npackages/ui"}
						className="font-mono text-xs leading-5"
					/>
				</Field>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field id="wz-build" label="Build with">
						<Select
							value={v.build}
							onValueChange={(b) => w.set("build", b as V["build"])}
						>
							<SelectTrigger id="wz-build" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(BUILD_LABEL).map(([k, label]) => (
									<SelectItem key={k} value={k}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<Field id="wz-port" label="Container port" error={w.error("port")}>
						<Input
							{...w.bind("port")}
							inputMode="numeric"
							className="tabular"
						/>
					</Field>
				</div>
				{name}
				<ReleaseAdvanced w={w} />
			</div>
		);
	}
	if (v.kind === "image") {
		return (
			<div className="grid gap-4">
				<Field
					id="wz-image"
					label="Image"
					error={w.error("image")}
					hint="Pin a version tag or digest; :latest makes rollbacks unpredictable."
				>
					<Input
						{...w.bind("image")}
						placeholder="ghcr.io/acme/web:2.4.1"
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
						autoFocus
					/>
				</Field>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field id="wz-port" label="Container port" error={w.error("port")}>
						<Input
							{...w.bind("port")}
							inputMode="numeric"
							className="tabular"
						/>
					</Field>
					{name}
				</div>
				<HostAdvanced w={w} />
				<ReleaseAdvanced w={w} />
			</div>
		);
	}
	if (v.kind === "database") {
		const engine = ENGINES[v.engine];
		return (
			<div className="grid gap-5">
				<ChoiceGroup
					label="Engine"
					value={v.engine}
					onChange={(e) => {
						w.set("engine", e);
						w.set("version", ENGINES[e].versions[0] ?? "");
					}}
					columns={2}
					choices={(Object.keys(ENGINES) as DatabaseEngine[]).map((k) => ({
						value: k,
						title: ENGINES[k].label,
						description: `Port ${ENGINES[k].port} · ${ENGINES[k].versions.join(", ")}`,
						icon: brandMark(databaseIcon[k]),
					}))}
				/>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field id="wz-version" label="Version">
						<Select
							value={v.version}
							onValueChange={(x) => w.set("version", x)}
						>
							<SelectTrigger id="wz-version" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{engine.versions.map((x) => (
									<SelectItem key={x} value={x}>
										{engine.label} {x}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					{name}
				</div>
				<p className="text-sm text-muted-foreground">
					Credentials are generated and stored encrypted. Add a backup schedule
					from the service once it's running.
				</p>
			</div>
		);
	}
	// Git stacks read the file through a provider's API, so a generic SSH remote cannot serve one.
	const apiProviders = providers.filter((p) => p.kind !== "generic");
	const from = apiProviders.length ? v.composeFrom : "paste";
	return (
		<div className="grid gap-4">
			{apiProviders.length > 0 && (
				<ChoiceGroup
					label="Compose file"
					value={from}
					onChange={(f) => {
						w.set("composeFrom", f);
						if (f === "git" && !apiProviders.some((p) => p.id === v.providerId))
							w.set("providerId", apiProviders[0]?.id ?? "");
					}}
					columns={2}
					choices={[
						{
							value: "paste",
							title: "Paste a file",
							description: "Edit it later from the stack's Compose tab.",
							icon: PenLine,
						},
						{
							value: "git",
							title: "From a repository",
							description:
								"Read from a branch; every push re-syncs the stack and rebuilds build: services.",
							icon: GitBranch,
						},
					]}
				/>
			)}
			{from === "git" ? (
				<>
					<Field id="wz-providerId" label="Git provider">
						<Select
							value={v.providerId}
							onValueChange={(id) => {
								w.set("providerId", id);
								w.set("repository", "");
							}}
						>
							<SelectTrigger id="wz-providerId" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{apiProviders.map((p) => {
									const Icon = GIT_KIND[p.kind].icon;
									return (
										<SelectItem key={p.id} value={p.id}>
											<Icon aria-hidden />
											{p.name}
										</SelectItem>
									);
								})}
							</SelectContent>
						</Select>
					</Field>
					<Field
						id="wz-repository"
						label="Repository"
						error={w.error("repository")}
					>
						<RepoPicker key={v.providerId} w={w} />
					</Field>
					<div className="grid gap-4 sm:grid-cols-2">
						<BranchField w={w} />
						<Field
							id="wz-composePath"
							label="Compose file path"
							error={w.error("composePath")}
							hint="From the repository root."
						>
							<Input
								{...w.bind("composePath")}
								className="font-mono"
								spellCheck={false}
								autoCapitalize="none"
							/>
						</Field>
					</div>
					{name}
				</>
			) : (
				<>
					<PasteCompose w={w} />
					{name}
				</>
			)}
		</div>
	);
}

function PasteCompose({ w }: { w: WizardApi<V> }) {
	return (
		<Field
			id="wz-composeYaml"
			label="Compose file"
			error={w.error("composeYaml")}
			hint="Each compose service becomes a container of one stack, reachable by its name. Official database images become managed databases. build: needs a repository; host paths and privileged mode are not supported. Add domains from the stack once it runs."
		>
			<Textarea
				{...w.bind("composeYaml")}
				rows={10}
				spellCheck={false}
				placeholder={
					"services:\n  web:\n    image: nginx:1.29\n    ports:\n      - 80"
				}
				className="font-mono text-xs leading-5"
				autoFocus
			/>
		</Field>
	);
}

function toBuild(v: V): BuildConfig {
	if (v.kind === "image" || v.kind === "webserver") return { type: "image" };
	if (v.build === "dockerfile")
		return { type: "dockerfile", dockerfilePath: "Dockerfile", context: "." };
	if (v.build === "static") return { type: "static", publishDir: "dist" };
	return { type: "railpack" };
}

/** Validates the host settings alone, so each issue's path indexes the rows the user sees. */
const hostIssues = (host: HostSettings) => {
	const parsed = SpecSchema.safeParse({
		kind: "application",
		source: { type: "image", image: "probe" },
		build: { type: "image" },
		replicas: 1,
		resources: {},
		placement: [],
		...host,
	});
	return parsed.success ? [] : parsed.error.issues;
};

const hasHostSettings = (h: HostSettings) =>
	JSON.stringify(h) !== JSON.stringify(DEFAULTS.host);

function hostRows(h: HostSettings) {
	const mono = (lines: string[]) => (
		<span className="grid font-mono text-xs">
			{lines.map((l) => (
				<span key={l}>{l}</span>
			))}
		</span>
	);
	const caps = [
		...(h.capAdd ?? []).map((c) => `+${c}`),
		...(h.capDrop ?? []).map((c) => `-${c}`),
	];
	return [
		...(h.ports.length
			? [
					{
						label: "Published ports",
						value: mono(
							h.ports.map(
								(p) =>
									`${p.published ?? "-"}:${p.target}/${p.protocol}${p.published && p.mode === "ingress" ? " every node" : ""}`,
							),
						),
					},
				]
			: []),
		...(h.mounts?.length
			? [
					{
						label: "Bind mounts",
						value: mono(
							h.mounts.map(
								(m) => `${m.hostPath}:${m.target}${m.readOnly ? ":ro" : ""}`,
							),
						),
					},
				]
			: []),
		...(h.user ? [{ label: "Run as", value: mono([h.user]) }] : []),
		...(caps.length ? [{ label: "Capabilities", value: mono(caps) }] : []),
		...(h.restart
			? [
					{
						label: "Restart",
						value: h.restart === "none" ? "Never" : "On failure",
					},
				]
			: []),
	];
}

/** Collapsed by default so the common path stays three fields long. */
function HostAdvanced({ w }: { w: WizardApi<V> }) {
	const host = w.values.host;
	const [open, setOpen] = useState(() => hasHostSettings(host));
	const issues = hostIssues(host);
	const error = w.error("host");
	const patch = (p: Partial<HostSettings>) => w.set("host", { ...host, ...p });
	return (
		<Collapsible
			open={open || Boolean(error)}
			onOpenChange={setOpen}
			className="group/adv mt-4 grid gap-1"
		>
			<CollapsibleTrigger className="flex w-fit items-center gap-1.5 rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
				Advanced
				<ChevronDown
					className="size-4 text-muted-foreground transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]/adv:rotate-180"
					aria-hidden
				/>
			</CollapsibleTrigger>
			<p
				className={cn(
					"text-sm",
					error ? "text-bad-text" : "text-muted-foreground",
				)}
				aria-live="polite"
			>
				{error ??
					"Published ports, host paths, user, capabilities and restart."}
			</p>
			<CollapsibleContent className="t-reveal grid gap-7 pt-4">
				<section aria-labelledby="wz-host-ports" className="grid gap-2">
					<h3 id="wz-host-ports" className="text-sm font-medium">
						Published ports
					</h3>
					<p className="-mt-1 text-xs text-muted-foreground">
						For traffic that doesn't go through a domain, like a game server on
						UDP. A port binds on the replica's node unless you choose every
						node.
					</p>
					<PortRows value={host} onChange={patch} issues={issues} />
				</section>
				<section aria-labelledby="wz-host-mounts" className="grid gap-2">
					<h3 id="wz-host-mounts" className="text-sm font-medium">
						Bind mounts
					</h3>
					<MountRows value={host} onChange={patch} issues={issues} />
				</section>
				<ProcessFields
					value={host}
					onChange={patch}
					issues={issues}
					idPrefix="wz-host-"
				/>
			</CollapsibleContent>
		</Collapsible>
	);
}

function releaseRows(r: ReleaseSettings) {
	return (["preDeploy", "postDeploy"] as const).flatMap((phase) => {
		const c = r[phase];
		return c
			? [
					{
						label: phase === "preDeploy" ? "Pre-deploy" : "Post-deploy",
						value: (
							<span className="font-mono text-xs">
								{JSON.stringify(c.command)}
							</span>
						),
					},
				]
			: [];
	});
}

/** Collapsed unless set, like the host settings. */
function ReleaseAdvanced({ w }: { w: WizardApi<V> }) {
	const release = w.values.release;
	const [open, setOpen] = useState(
		() => !!(release.preDeploy || release.postDeploy),
	);
	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="group/rel mt-4 grid gap-1"
		>
			<CollapsibleTrigger className="flex w-fit items-center gap-1.5 rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
				Release commands
				<ChevronDown
					className="size-4 text-muted-foreground transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]/rel:rotate-180"
					aria-hidden
				/>
			</CollapsibleTrigger>
			<p className="text-sm text-muted-foreground">
				Migrations and other one-off runs before or after each rollout.
			</p>
			<CollapsibleContent className="t-reveal grid gap-7 pt-4">
				<ReleaseCommandFields
					value={release}
					onChange={(p) => w.set("release", { ...release, ...p })}
					idPrefix="wz-"
				/>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** The preset's config: the default, or the load balancer generated from its form. */
const webserverConfig = (v: V) =>
	v.webserver === "haproxy"
		? loadBalancerConfig(v.lb)
		: WEBSERVERS[v.webserver].defaultConfig;

function webserverRows(v: V) {
	const def = WEBSERVERS[v.webserver];
	const mono = (t: string) => <span className="font-mono text-xs">{t}</span>;
	if (def.docroot)
		return [
			{ label: "Server", value: def.label },
			{ label: "Image", value: mono(def.image) },
			{ label: "Config file", value: mono(def.config) },
			{ label: "Static files", value: mono(def.docroot) },
		];
	return [
		{ label: "Server", value: `${def.label}, HAProxy` },
		{ label: "Image", value: mono(def.image) },
		{
			label: "Targets",
			value: (
				<span className="grid font-mono text-xs">
					{v.lb.targets
						.map((t) => t.trim())
						.filter(Boolean)
						.map((t) => (
							<span key={t}>{t}</span>
						))}
				</span>
			),
		},
		{
			label: "Balancing",
			value:
				v.lb.algorithm === "roundrobin" ? "Round robin" : "Fewest connections",
		},
		{
			label: "Health check",
			value: v.lb.healthPath ? mono(v.lb.healthPath) : "Port only",
		},
	];
}

function toSpec(v: V): ServiceSpec {
	if (v.kind === "storage")
		return { kind: "storage", engine: v.storageEngine, resources: {} };
	if (v.kind === "database")
		return {
			kind: "database",
			engine: v.engine,
			version: v.version,
			// The server mints the credentials into the service env when it creates the service.
			credentialsRef: "env",
			resources: {},
		};
	if (v.kind === "compose")
		return {
			kind: "compose",
			source: { type: "inline" },
			originalYaml: v.composeYaml,
			servicesOverrides: {},
		};
	return {
		kind: "application",
		source:
			v.kind === "git"
				? gitSource(v)
				: {
						type: "image",
						image:
							v.kind === "webserver"
								? WEBSERVERS[v.webserver].image
								: v.image.trim(),
					},
		build: toBuild(v),
		...imageHost(v),
		...(v.kind === "image" || v.kind === "git" ? v.release : {}),
		replicas: 1,
		resources: {},
		placement: [],
	};
}

/** The routed container port, plus the advanced settings for an image source. */
function imageHost(v: V): HostSettings {
	const { ports, ...rest } = v.kind === "image" ? v.host : DEFAULTS.host;
	return { ...rest, ports: withRoutedPort(Number(v.port), ports) };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Watch paths and the push webhook. The service already exists, so a failure here only warns. */
async function wirePushes(serviceId: ServiceId, v: V) {
	const paths = v.kind === "git" ? watchPathList(v.watchPaths) : [];
	if (paths.length)
		await integrations.watchPaths.put(serviceId, paths).catch((e: unknown) =>
			toast.warning("Watch paths weren't saved", {
				description: `${errorText(e)} Every push builds until you set them on the service.`,
			}),
		);
	if (v.kind !== "git" || !v.providerId) return null;
	return integrations.git.webhook(v.providerId, v.repository).catch(
		(e: unknown): WebhookOutcome => ({
			status: "failed",
			message: errorText(e),
		}),
	);
}

function NewService() {
	const { projectId } = Route.useParams();
	const { env: envParam, step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: project } = useQuery(projectQuery(projectId));
	const { data: status } = useQuery(instanceStatusQuery);
	const create = useCreateService();
	const { data: resourceProfiles } = useResourceProfiles();
	const createStack = useCreateComposeStack();
	const createGitStack = useCreateGitStack();
	const providers = useQuery(gitProvidersQuery);

	const env =
		project?.environments.find((e) => e.id === envParam) ??
		project?.environments.find((e) => e.isDefault) ??
		project?.environments[0];
	// shortcut: generated hostnames assume sslip.io until instance settings are exposed by the API.
	const base = `${(status?.publicIp ?? "0.0.0.0").replaceAll(".", "-")}.sslip.io`;
	const connected = useMemo(
		() => providers.data?.filter((p) => p.state === "connected") ?? [],
		[providers.data],
	);
	const siblings = useQuery({
		...servicesQuery(env?.id ?? ("" as Environment["id"])),
		enabled: Boolean(env),
	});
	const suggestions = useMemo(
		() => targetSuggestions(siblings.data ?? []),
		[siblings.data],
	);
	const steps = useMemo(
		() => (env ? buildSteps(env, base, connected, suggestions) : []),
		[env, base, connected, suggestions],
	);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);

	// The provider list sets the default source, so the wizard waits for it.
	if (!project || !env || providers.isPending) return null;

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="New service"
				description={
					<>
						In <span className="text-foreground">{project.name}</span> ·{" "}
						<span className="text-foreground">{env.name}</span>
					</>
				}
			/>
			<Wizard
				id={`new-service:${env.id}`}
				steps={steps}
				defaultValues={{ ...DEFAULTS, providerId: connected[0]?.id ?? "" }}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Create and deploy"
				onComplete={async (v) => {
					const name = serviceName(v);
					if (v.kind === "compose") {
						const fromGit = v.composeFrom === "git";
						const made = await (fromGit
							? createGitStack.mutateAsync({
									environmentId: env.id,
									name,
									git: {
										gitProviderId: v.providerId,
										repository: v.repository,
										branch: v.branch.trim(),
										composePath: v.composePath.trim().replace(/^\.\//, ""),
									},
								})
							: createStack.mutateAsync({
									environmentId: env.id,
									name,
									composeYaml: v.composeYaml,
								})
						).catch((e: unknown) => {
							throw e instanceof ApiError && Array.isArray(e.details)
								? new Error(`${e.message}: ${e.details.join("; ")}`)
								: e;
						});
						const hook = fromGit
							? await integrations.git
									.webhook(v.providerId, v.repository)
									.catch(
										(e: unknown): WebhookOutcome => ({
											status: "failed",
											message: errorText(e),
										}),
									)
							: null;
						toast.success(`${name} is deploying`, {
							description: `${made.services.length} containers start in dependency order.${hook?.status === "registered" || hook?.status === "exists" ? ` Pushes to ${v.branch.trim()} re-sync it.` : ""}`,
							icon: <Layers className="size-4" />,
						});
						if (hook?.status === "failed")
							toast.warning("Add the push webhook by hand", {
								description: `${hook.message} Copy the webhook URL from Git providers into the repository's webhook settings.`,
								duration: 12_000,
							});
						await navigate({
							to: "/projects/$projectId/stacks/$stackId",
							params: { projectId, stackId: made.stackId as StackId },
						});
						return;
					}
					const spec = toSpec(v);
					const profile = chosenProfile(v, resourceProfiles);
					// With no choice to send (storage, or profiles still loading) the server applies the default.
					const sized =
						spec.kind === "storage" ||
						spec.kind === "compose" ||
						!resourceProfiles
							? { spec }
							: {
									spec: {
										...spec,
										resources: profile ? limitsOf(profile) : {},
									},
									resourceProfile: profile?.name ?? null,
								};
					const service = await create.mutateAsync({
						environmentId: env.id,
						name,
						...sized,
						...(v.kind === "webserver" && {
							importedFrom: webserverMarker(v.webserver),
							mounts: webserverMounts(v.webserver, webserverConfig(v)),
						}),
						...(v.kind === "storage"
							? storageDomains(v)
							: {
									domain:
										v.kind === "database" || v.domainMode === "none"
											? null
											: v.domainMode === "custom"
												? {
														kind: "custom",
														hostname: v.hostname.trim().toLowerCase(),
														port: Number(v.port) || 80,
														https: v.https,
													}
												: { kind: "generated", port: Number(v.port) || 80 },
								}),
					});
					if (v.kind === "storage") {
						toast.success(`${name} is starting`, {
							description:
								"Create a bucket once the engine reports healthy, usually within a minute.",
							icon: <HardDrive className="size-4" />,
						});
						await navigate({
							to: "/projects/$projectId/services/$serviceId/storage",
							params: { projectId, serviceId: service.id },
						});
						return;
					}
					const hook = await wirePushes(service.id, v);
					toast.success(`${name} is deploying`, {
						description:
							hook?.status === "registered" || hook?.status === "exists"
								? `Pushes to ${v.branch.trim()} deploy it. Follow the first deployment in ${env.name}.`
								: `Follow the first deployment in ${env.name}.`,
						icon: <Box className="size-4" />,
					});
					if (hook?.status === "failed")
						toast.warning("Add the push webhook by hand", {
							description: `${hook.message} Copy the webhook URL from Git providers into the repository's webhook settings.`,
							duration: 12_000,
						});
					await navigate({
						to: "/projects/$projectId",
						params: { projectId },
						search: { env: env.id },
					});
				}}
			/>
		</Page>
	);
}
