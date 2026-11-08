import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { GitBranch, RefreshCw, ShieldAlert, Unlink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { BranchField, RepoPicker } from "@/components/git/repo-picker";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Summary, TestPanel } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import {
	checkGitops,
	type GitopsLink,
	useLinkGitops,
	useSyncGitops,
	useUnlinkGitops,
} from "@/lib/api/gitops";
import { type GitProvider, gitProvidersQuery } from "@/lib/api/integrations";
import { relativeTime } from "@/lib/format";
import { GITOPS_STATUS } from "@/lib/status";

type V = {
	projectId: string;
	providerId: string;
	repository: string;
	branch: string;
	path: string;
	autoApply: boolean;
	managed: boolean;
	prune: boolean;
};

const defaults = (projectId: string, l: GitopsLink | null): V => ({
	projectId,
	providerId: l?.gitProviderId ?? "",
	repository: l?.repository ?? "",
	branch: l?.branch ?? "main",
	path: l?.path ?? "logistack.yaml",
	autoApply: l?.autoApply ?? true,
	managed: l?.managed ?? false,
	prune: l?.prune ?? false,
});

const source = (v: V) => ({
	gitProviderId: v.providerId,
	repository: v.repository,
	branch: v.branch,
	path: v.path.trim(),
});

function ProviderField({
	w,
	providers,
}: {
	w: WizardApi<V>;
	/** Undefined while loading. */
	providers: GitProvider[] | undefined;
}) {
	return (
		<Field
			id="wz-providerId"
			label="Git provider"
			error={w.error("providerId")}
			hint={
				providers?.length !== 0 ? (
					"The connection LogiStack reads the repository through. Its webhook delivers the pushes."
				) : (
					<>
						No git provider is connected yet.{" "}
						<Link
							to="/integrations/git"
							className="font-medium text-foreground underline underline-offset-3"
						>
							Connect one in Integrations
						</Link>
						, then come back.
					</>
				)
			}
		>
			<Select
				value={w.values.providerId || undefined}
				onValueChange={(id) => {
					w.set("providerId", id);
					w.set("repository", "");
				}}
			>
				<SelectTrigger
					id="wz-providerId"
					className="w-full"
					aria-invalid={w.error("providerId") ? true : undefined}
					aria-describedby="wz-providerId-msg"
				>
					<SelectValue placeholder="Choose a provider" />
				</SelectTrigger>
				<SelectContent>
					{providers?.map((p) => (
						<SelectItem key={p.id} value={p.id}>
							{p.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</Field>
	);
}

function RepositoryStep({ w }: { w: WizardApi<V> }) {
	const { data } = useQuery(gitProvidersQuery);
	const providers = data?.filter((p) => p.state === "connected");
	return (
		<div className="grid gap-6">
			<ProviderField w={w} providers={providers} />
			{w.values.providerId && (
				<div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
					<Field
						id="wz-repository"
						label="Repository"
						error={w.error("repository")}
					>
						<RepoPicker key={w.values.providerId} w={w as never} />
					</Field>
					<BranchField w={w as never} />
				</div>
			)}
		</div>
	);
}

/** The last plan the manifest test read, by project; shown under the test panel. */
const plans = new Map<string, string[]>();

function ManifestStep({ w }: { w: WizardApi<V> }) {
	const t = w.test;
	return (
		<div className="grid gap-5">
			<Field
				id="wz-path"
				label="Manifest path"
				error={w.error("path")}
				hint={
					<>
						A project manifest (<code className="font-mono">kind: project</code>
						) inside the repository. Export this project from its menu to start
						one that matches what runs today.
					</>
				}
			>
				<Input
					{...w.bind("path")}
					autoCapitalize="none"
					spellCheck={false}
					className="font-mono"
					placeholder="deploy/logistack.yaml"
				/>
			</Field>
			<TestPanel
				w={w}
				action="Read and plan"
				idle="Reads the file through the provider and plans it against the project."
			/>
			{t.phase === "passed" && plans.get(w.values.projectId)?.length ? (
				<pre className="max-h-64 overflow-auto rounded-lg bg-muted/60 p-4 font-mono text-xs leading-relaxed text-muted-foreground dark:bg-muted/40">
					{plans.get(w.values.projectId)?.join("\n")}
				</pre>
			) : null}
		</div>
	);
}

function ToggleRow({
	id,
	title,
	body,
	checked,
	onChange,
}: {
	id: string;
	title: string;
	body: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label
			htmlFor={id}
			className="flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-muted/40"
		>
			<span>
				<span className="block font-medium">{title}</span>
				<span className="text-pretty text-muted-foreground">{body}</span>
			</span>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</label>
	);
}

function ModeStep({ w }: { w: WizardApi<V> }) {
	return (
		<div className="grid gap-2">
			<ToggleRow
				id="wz-autoApply"
				title="Apply on push"
				body="A push that changes the manifest applies it and deploys the services it changed. Off, a push only records what would change."
				checked={w.values.autoApply}
				onChange={(c) => w.set("autoApply", c)}
			/>
			<ToggleRow
				id="wz-managed"
				title="Managed by git"
				body="Edits to this project in the dashboard, the API and MCP are refused and point at the repository. Secrets and deploys stay open."
				checked={w.values.managed}
				onChange={(c) => w.set("managed", c)}
			/>
			<ToggleRow
				id="wz-prune"
				title="Delete what the manifest leaves out"
				body="Environments, services, domains, variables and backup policies the file does not list are removed on apply."
				checked={w.values.prune}
				onChange={(c) => w.set("prune", c)}
			/>
			{w.values.prune && (
				<div
					role="note"
					className="flex gap-3 rounded-lg bg-warn/10 p-4 text-sm ring-1 ring-warn/30"
				>
					<ShieldAlert
						className="mt-0.5 size-4 shrink-0 text-warn-text"
						aria-hidden
					/>
					<p className="text-pretty text-muted-foreground">
						<span className="font-medium text-warn-text">
							A service removed from the file is deleted with its volumes.
						</span>{" "}
						Keep this off until the manifest lists everything the project runs.
					</p>
				</div>
			)}
		</div>
	);
}

function ProviderName({ id }: { id: string }) {
	const { data } = useQuery(gitProvidersQuery);
	return data?.find((p) => p.id === id)?.name ?? "None";
}

const onOff = (b: boolean) => (b ? "On" : "Off");

const steps = (projectId: string): WizardStep<V>[] => [
	{
		id: "repository",
		title: "Repository",
		description:
			"Where the project's manifest lives. Pushes to this branch are what LogiStack follows.",
		schema: z.object({
			providerId: z.string().min(1, "Choose a git provider."),
			repository: z.string().min(1, "Choose a repository."),
			branch: z.string().trim().min(1, "Name the branch."),
		}),
		render: (w) => <RepositoryStep w={w} />,
	},
	{
		id: "manifest",
		title: "Manifest",
		description:
			"LogiStack reads the file at the branch head and shows what applying it would change. Nothing is applied yet.",
		schema: z.object({
			path: z
				.string()
				.trim()
				.min(1, "Name the file.")
				.refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
					message: "A path inside the repository, like deploy/logistack.yaml.",
				}),
		}),
		testKeys: ["providerId", "repository", "branch", "path"],
		test: async (v) => {
			try {
				const plan = await checkGitops(projectId, {
					...source(v),
					prune: v.prune,
				});
				const lines = plan.changes.flatMap((c) => [
					`${{ create: "+", update: "~", delete: "-" }[c.op]} ${c.resource} ${[c.environment, c.service, c.name].filter(Boolean).join("/")}`,
					...c.changes.map((d) => `    ${d}`),
				]);
				plans.set(projectId, [
					...lines,
					...plan.warnings.map((x) => `warning: ${x}`),
				]);
				return {
					ok: true,
					message: plan.changes.length
						? `Read ${v.path.trim()}: ${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"} on the first sync`
						: `Read ${v.path.trim()}: it matches what the project runs`,
					detail: plan.changes.length
						? "Applied on the next push, or when you Sync now."
						: "Nothing changes until the file does.",
				};
			} catch (e) {
				return { ok: false, message: (e as Error).message };
			}
		},
		render: (w) => <ManifestStep w={w} />,
	},
	{
		id: "mode",
		title: "How it applies",
		render: (w) => <ModeStep w={w} />,
	},
	{
		id: "review",
		title: "Review",
		render: (w) => (
			<Summary
				w={w}
				sections={[
					{
						stepId: "repository",
						title: "Repository",
						rows: [
							{
								label: "Provider",
								value: <ProviderName id={w.values.providerId} />,
							},
							{
								label: "Repository",
								value: (
									<span className="font-mono text-xs">
										{w.values.repository}#{w.values.branch}
									</span>
								),
							},
						],
					},
					{
						stepId: "manifest",
						title: "Manifest",
						rows: [
							{
								label: "Path",
								value: (
									<span className="font-mono text-xs">{w.values.path}</span>
								),
							},
						],
					},
					{
						stepId: "mode",
						title: "How it applies",
						rows: [
							{ label: "Apply on push", value: onOff(w.values.autoApply) },
							{ label: "Managed by git", value: onOff(w.values.managed) },
							{
								label: "Delete what is left out",
								value: onOff(w.values.prune),
							},
						],
					},
				]}
			/>
		),
	},
];

export function GitopsWizard({
	projectId,
	link,
	step,
	onStepChange,
}: {
	projectId: string;
	link: GitopsLink | null;
	step: string | undefined;
	onStepChange: (id: string, opts: { replace: boolean }) => void;
}) {
	const navigate = useNavigate();
	const save = useLinkGitops(projectId);
	return (
		<Wizard
			id={`gitops:${projectId}`}
			steps={steps(projectId)}
			defaultValues={defaults(projectId, link)}
			step={step}
			onStepChange={onStepChange}
			finishLabel={link ? "Save changes" : "Follow this repository"}
			onComplete={async (v) => {
				await save.mutateAsync({
					...source(v),
					autoApply: v.autoApply,
					managed: v.managed,
					prune: v.prune,
				});
				toast.success(
					link ? "GitOps settings saved" : "Following the repository",
					{
						description: v.autoApply
							? "The next push that changes the manifest applies it. Sync now to apply it at once."
							: "Pushes record what would change; apply them with Sync now.",
					},
				);
				await navigate({
					to: "/projects/$projectId/gitops",
					params: { projectId },
					search: {},
				});
			}}
		/>
	);
}

/** The link and its last sync, with Sync now, Edit and Stop following. */
export function GitopsStatus({
	projectId,
	link,
	onEdit,
}: {
	projectId: string;
	link: GitopsLink;
	onEdit: () => void;
}) {
	const sync = useSyncGitops(projectId);
	const unlink = useUnlinkGitops(projectId);
	const [confirming, setConfirming] = useState(false);
	const meta = link.lastStatus ? GITOPS_STATUS[link.lastStatus] : null;
	const run = () =>
		sync.mutate(undefined, {
			onSuccess: (r) =>
				r.status === "failed"
					? toast.error("Sync failed", { description: r.error?.message })
					: toast.success(
							r.status === "unchanged"
								? "Already in sync"
								: r.status === "planned"
									? `${r.changes} change${r.changes === 1 ? "" : "s"} waiting`
									: `Applied ${r.changes} change${r.changes === 1 ? "" : "s"}`,
							r.deployments.length
								? {
										description: `${r.deployments.length} deployment${r.deployments.length === 1 ? "" : "s"} queued.`,
									}
								: undefined,
						),
			onError: (e) => toast.error("Couldn't sync", { description: e.message }),
		});
	return (
		<section
			aria-labelledby="gitops-source"
			className="grid gap-4 rounded-xl bg-card p-5 ring-1 ring-border"
		>
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="grid min-w-0 gap-1">
					<h2
						id="gitops-source"
						className="flex items-center gap-2 text-sm font-medium"
					>
						<GitBranch className="size-4 text-muted-foreground" aria-hidden />
						<span className="truncate font-mono">
							{link.repository}#{link.branch}
						</span>
					</h2>
					<p className="truncate font-mono text-xs text-muted-foreground">
						{link.path}
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap gap-2">
					<Button variant="outline" size="sm" onClick={onEdit}>
						Edit
					</Button>
					{confirming ? (
						<Button
							variant="destructive"
							size="sm"
							disabled={unlink.isPending}
							onClick={() =>
								unlink.mutate(undefined, {
									onSuccess: () =>
										toast.success("Stopped following the repository", {
											description:
												"The project keeps its state and takes edits again.",
										}),
									onError: (e) =>
										toast.error("Couldn't stop following", {
											description: e.message,
										}),
								})
							}
						>
							<Unlink data-icon="inline-start" />
							Confirm stop
						</Button>
					) : (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setConfirming(true)}
						>
							Stop following
						</Button>
					)}
					<Button size="sm" disabled={sync.isPending} onClick={run}>
						<RefreshCw
							data-icon="inline-start"
							className={sync.isPending ? "animate-spin" : undefined}
						/>
						Sync now
					</Button>
				</div>
			</div>
			<dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
				<div>
					<dt className="text-xs text-muted-foreground">Last sync</dt>
					<dd className="flex items-center gap-2" role="status">
						{meta ? (
							<>
								<StatusDot meta={meta} />
								{meta.label}
								{link.lastSyncedAt && (
									<span className="text-muted-foreground">
										{relativeTime(String(link.lastSyncedAt))}
									</span>
								)}
							</>
						) : (
							<span className="text-muted-foreground">Not synced yet</span>
						)}
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Commit</dt>
					<dd>
						{link.lastCommitSha ? (
							<span className="font-mono text-xs">
								{link.lastCommitSha.slice(0, 12)}
							</span>
						) : (
							<span className="text-muted-foreground">None yet</span>
						)}
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Mode</dt>
					<dd>
						{[
							link.autoApply ? "Applies on push" : "Plans on push",
							link.managed && "managed by git",
							link.prune && "deletes what is left out",
						]
							.filter(Boolean)
							.join(", ")}
					</dd>
				</div>
			</dl>
			{link.lastError && (
				<div
					role="alert"
					className="grid gap-2 rounded-lg bg-bad/10 p-4 text-sm ring-1 ring-bad/30"
				>
					<p className="font-medium text-bad-text">
						The last push could not be applied
						{link.lastError.commitSha &&
							` (${link.lastError.commitSha.slice(0, 7)})`}
					</p>
					<p className="text-pretty break-words text-muted-foreground">
						{link.lastError.message}
					</p>
					{link.lastError.details.length > 0 && (
						<ul className="grid gap-1 font-mono text-xs text-muted-foreground">
							{link.lastError.details.map((d) => (
								<li key={d} className="break-words">
									{d}
								</li>
							))}
						</ul>
					)}
					<p className="text-xs text-muted-foreground">
						Nothing changed in the project. Fix the file and push again, or Sync
						now.
					</p>
				</div>
			)}
		</section>
	);
}
