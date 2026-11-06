import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, FileUp, Info, KeyRound } from "lucide-react";
import {
	type DragEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { z } from "zod";
import { CopyField } from "@/components/copy-button";
import { Field } from "@/components/field";
import { Page, PageHeader } from "@/components/page-header";
import { SkeletonRows } from "@/components/panel";
import { CHANGE_OP } from "@/components/stack/compose-changes";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { ApiError } from "@/lib/api";
import {
	type ApplyResult,
	type ManifestChange,
	type ManifestScope,
	manifestApi,
	useApplyManifest,
} from "@/lib/api/manifest";
import { useProject } from "@/lib/api/projects";
import type { ProjectDetail } from "@/lib/api/types";
import { stepParam } from "@/lib/search";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/projects/$projectId/import")({
	validateSearch: z.object({
		step: stepParam,
		env: z.string().startsWith("env_").optional().catch(undefined),
	}),
	staticData: { crumb: "Import manifest" },
	component: ImportManifest,
});

type Kind = ManifestScope["kind"];

type V = {
	manifest: string;
	fileName: string;
	/** The environment an environment manifest applies to. */
	target: string;
	prune: boolean;
};

/** The top-level `kind` of a YAML or JSON manifest; the server parses the rest. */
function manifestKind(text: string): Kind | null {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		try {
			const kind = (JSON.parse(trimmed) as { kind?: unknown }).kind;
			return kind === "project" || kind === "environment" ? kind : null;
		} catch {
			return null;
		}
	}
	const m = /^kind:\s*["']?(project|environment)["']?\s*(#.*)?$/m.exec(text);
	return (m?.[1] as Kind | undefined) ?? null;
}

const KIND_LABEL: Record<Kind, string> = {
	project: "Project manifest",
	environment: "Environment manifest",
};

const MAX_BYTES = 1_000_000;

const manifestField = z
	.string()
	.trim()
	.min(1, "Drop a manifest file or paste one.")
	.refine(
		(t) => manifestKind(t) !== null,
		"No top-level kind: project or kind: environment. Export a manifest from LogiStack to start from one.",
	);

function scopeOf(v: V, project: ProjectDetail): ManifestScope | null {
	const kind = manifestKind(v.manifest);
	if (kind === "project") return { kind, id: project.id };
	if (kind === "environment" && v.target) return { kind, id: v.target };
	return null;
}

function SourceStep({
	w,
	project,
}: {
	w: WizardApi<V>;
	project: ProjectDetail;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const kind = manifestKind(w.values.manifest);

	async function pick(file: File | undefined) {
		if (!file) return;
		if (file.size > MAX_BYTES) {
			toast.error("That file is too large", {
				description: "A manifest is plain text well under 1 MB.",
			});
			return;
		}
		w.set("manifest", await file.text());
		w.set("fileName", file.name);
	}

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		setDragging(false);
		void pick(e.dataTransfer.files[0]);
	};

	return (
		<div className="grid gap-5">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; Choose file is the keyboard path */}
			<div
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={onDrop}
				className={cn(
					"flex flex-col items-start gap-3 rounded-lg bg-muted/60 p-4 ring-1 ring-transparent transition-[box-shadow,background-color] duration-(--duration-quick) sm:flex-row sm:items-center dark:bg-muted/40",
					dragging && "bg-brand/5 ring-2 ring-brand",
				)}
			>
				<span className="grid size-9 shrink-0 place-items-center rounded-md bg-card text-muted-foreground ring-1 ring-border">
					<FileUp className="size-4" strokeWidth={1.75} aria-hidden />
				</span>
				<div className="min-w-0 flex-1 text-sm">
					<p className="font-medium">
						{w.values.fileName || "Drop a .yaml, .yml or .json file"}
					</p>
					<p className="text-muted-foreground">
						Or paste it below. Export one from any project to start from its
						current state.
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					onClick={() => input.current?.click()}
				>
					Choose file
				</Button>
				<input
					ref={input}
					type="file"
					accept=".yaml,.yml,.json,application/json,text/yaml"
					className="sr-only"
					tabIndex={-1}
					aria-hidden
					onChange={(e) => {
						void pick(e.target.files?.[0]);
						e.target.value = "";
					}}
				/>
			</div>

			<Field
				id="wz-manifest"
				label="Manifest"
				error={w.error("manifest")}
				hint={kind ? KIND_LABEL[kind] : "YAML or JSON."}
			>
				<Textarea
					{...w.bind("manifest")}
					onChange={(e) => {
						w.set("manifest", e.target.value);
						if (w.values.fileName) w.set("fileName", "");
					}}
					spellCheck={false}
					autoComplete="off"
					placeholder={
						"version: 1\nkind: project\nproject:\n  name: Storefront"
					}
					className="max-h-[50vh] min-h-48 font-mono text-xs leading-5 md:text-xs"
				/>
			</Field>

			{kind === "environment" && (
				<Field
					id="wz-target"
					label="Apply to"
					error={w.error("target")}
					hint={`An environment manifest applies to one environment of ${project.name}.`}
				>
					<Select
						value={w.values.target}
						onValueChange={(t) => w.set("target", t)}
					>
						<SelectTrigger
							id="wz-target"
							className="w-full max-w-xs"
							aria-invalid={w.error("target") ? true : undefined}
							aria-describedby="wz-target-msg"
						>
							<SelectValue placeholder="Choose an environment" />
						</SelectTrigger>
						<SelectContent>
							{project.environments.map((e) => (
								<SelectItem key={e.id} value={e.id}>
									{e.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			)}
		</div>
	);
}

const RESOURCE: Record<ManifestChange["resource"], string> = {
	project: "Project",
	environment: "Environment",
	variable: "Variable",
	stack: "Stack",
	service: "Service",
	domain: "Domain",
	backup: "Backup",
};

/** Changes by environment, then by service; project-level ones first. */
function groupChanges(changes: ManifestChange[]) {
	const envs = new Map<string, Map<string, ManifestChange[]>>();
	for (const c of changes) {
		const env = c.environment ?? "";
		const service = c.service ?? (c.resource === "service" ? c.name : "");
		const services = envs.get(env) ?? new Map<string, ManifestChange[]>();
		services.set(service, [...(services.get(service) ?? []), c]);
		envs.set(env, services);
	}
	return [...envs].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : 0));
}

function PlanChanges({
	changes,
	project,
}: {
	changes: ManifestChange[];
	project: ProjectDetail;
}) {
	const envName = (slug: string) =>
		slug === ""
			? project.name
			: (project.environments.find((e) => e.slug === slug)?.name ?? slug);
	return (
		<div className="grid gap-4">
			{groupChanges(changes).map(([env, services]) => (
				<section
					key={env}
					aria-label={envName(env)}
					className="overflow-hidden rounded-lg bg-card ring-1 ring-border"
				>
					<h3 className="border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
						{env === "" ? "Project" : envName(env)}
					</h3>
					<div className="divide-y">
						{[...services].map(([service, rows]) => (
							<div key={service} className="px-4 py-3">
								{service && (
									<p className="mb-1.5 font-mono text-sm">{service}</p>
								)}
								<ul className="grid gap-2">
									{rows.map((c) => {
										const op = CHANGE_OP[c.op];
										return (
											<li
												key={`${c.op}:${c.resource}:${c.name}`}
												className="flex gap-3"
											>
												<op.Icon
													className={cn("mt-1 size-3.5 shrink-0", op.tone)}
													aria-hidden
												/>
												<div className="min-w-0 text-sm">
													<p>
														<span className={cn("font-medium", op.tone)}>
															{op.label}
														</span>{" "}
														<span className="text-muted-foreground">
															{RESOURCE[c.resource].toLowerCase()}
														</span>{" "}
														<span className="font-mono text-xs break-all">
															{c.name}
														</span>
													</p>
													{c.changes.length > 0 && (
														<ul className="mt-0.5 grid gap-0.5 text-muted-foreground">
															{c.changes.map((line) => (
																<li
																	key={line}
																	className="text-pretty first-letter:uppercase"
																>
																	{line}
																</li>
															))}
														</ul>
													)}
												</div>
											</li>
										);
									})}
								</ul>
							</div>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function countLine(changes: ManifestChange[], done = false) {
	const n = (op: ManifestChange["op"]) =>
		changes.filter((c) => c.op === op).length;
	return [
		[n("create"), done ? "created" : "to create"],
		[n("update"), done ? "changed" : "to change"],
		[n("delete"), done ? "deleted" : "to delete"],
	]
		.filter(([count]) => count)
		.map(([count, what]) => `${count} ${what}`)
		.join(", ");
}

function Warnings({ warnings }: { warnings: string[] }) {
	if (!warnings.length) return null;
	return (
		<div
			role="note"
			className="flex gap-3 rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-muted/40"
		>
			<Info
				className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				aria-hidden
			/>
			<ul className="grid gap-1 text-pretty text-muted-foreground">
				{warnings.map((w) => (
					<li key={w}>{w}</li>
				))}
			</ul>
		</div>
	);
}

const detailLines = (details: unknown) =>
	Array.isArray(details)
		? details.map((d) =>
				typeof d === "string"
					? d
					: typeof d === "object" && d && "message" in d
						? String(d.message)
						: JSON.stringify(d),
			)
		: [];

function PlanStep({
	w,
	project,
	plan,
}: {
	w: WizardApi<V>;
	project: ProjectDetail;
	plan: { data?: ApplyResult; error: Error | null; isFetching: boolean };
}) {
	return (
		<div className="grid gap-5">
			<label
				htmlFor="wz-prune"
				className="flex cursor-pointer items-start justify-between gap-4 rounded-lg bg-card px-4 py-3 ring-1 ring-border"
			>
				<span className="text-sm">
					<span className="block font-medium">Prune</span>
					<span className="block text-pretty text-muted-foreground">
						Also delete services, domains, variables and backups the manifest
						does not list. Off, apply only creates and updates.
					</span>
				</span>
				<Switch
					id="wz-prune"
					className="mt-1"
					checked={w.values.prune}
					onCheckedChange={(on) => w.set("prune", on)}
				/>
			</label>

			<div aria-live="polite" aria-busy={plan.isFetching}>
				{plan.error ? (
					<div className="t-swap flex gap-3 rounded-lg bg-bad/10 px-4 py-3 text-sm">
						<CircleAlert
							className="mt-0.5 size-4 shrink-0 text-bad-text"
							aria-hidden
						/>
						<div className="min-w-0">
							<p className="font-medium text-bad-text">{plan.error.message}</p>
							<ul className="mt-1 grid gap-0.5 font-mono text-xs break-words text-muted-foreground">
								{detailLines(
									plan.error instanceof ApiError
										? plan.error.details
										: undefined,
								).map((l) => (
									<li key={l}>{l}</li>
								))}
							</ul>
							<Button
								type="button"
								variant="link"
								size="sm"
								className="mt-1 h-auto px-0"
								onClick={() => w.goTo("source")}
							>
								Edit the manifest
							</Button>
						</div>
					</div>
				) : !plan.data || plan.isFetching ? (
					<div className="overflow-hidden rounded-lg bg-card ring-1 ring-border">
						<SkeletonRows rows={4} />
						<span className="sr-only">Planning changes…</span>
					</div>
				) : plan.data.changes.length === 0 ? (
					<div className="t-reveal grid gap-4">
						<div className="grid justify-items-center gap-2 rounded-lg bg-card px-4 py-10 text-center ring-1 ring-border">
							<CircleCheck className="size-6 text-ok-text" aria-hidden />
							<p className="font-medium">Already up to date</p>
							<p className="max-w-[48ch] text-sm text-pretty text-muted-foreground">
								{project.name} matches this manifest. Applying it would change
								nothing.
							</p>
						</div>
						<Warnings warnings={plan.data.warnings} />
					</div>
				) : (
					<div className="t-reveal grid gap-4">
						<p className="text-sm text-muted-foreground tabular">
							{countLine(plan.data.changes)}. Nothing changes until you apply.
						</p>
						<Warnings warnings={plan.data.warnings} />
						<PlanChanges changes={plan.data.changes} project={project} />
					</div>
				)}
			</div>
		</div>
	);
}

function Applied({
	result,
	project,
}: {
	result: ApplyResult;
	project: ProjectDetail;
}) {
	return (
		<Page className="max-w-3xl">
			<PageHeader
				title="Manifest applied"
				description={
					<>
						Applied to <span className="text-foreground">{project.name}</span>
						{result.changes.length
							? `: ${countLine(result.changes, true)}.`
							: ". Nothing needed to change."}
					</>
				}
			/>
			<div className="t-reveal grid gap-6">
				{result.backupKeys.length > 0 && (
					<section
						aria-labelledby="backup-keys"
						className="rounded-lg bg-card p-4 ring-1 ring-border"
					>
						<div className="flex gap-3">
							<KeyRound
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							<div className="min-w-0 flex-1">
								<h2 id="backup-keys" className="text-sm font-medium">
									Store these backup keys now
								</h2>
								<p className="mt-0.5 text-sm text-pretty text-muted-foreground">
									They are shown once, here. An encrypted backup cannot be
									restored without its key.
								</p>
								<ul className="mt-3 grid gap-3">
									{result.backupKeys.map((k) => (
										<li key={k.key} className="grid gap-1.5">
											<p className="text-xs text-muted-foreground">
												<span className="font-mono text-foreground">
													{k.service}
												</span>{" "}
												in {k.environment} · {k.backup}
											</p>
											<CopyField
												value={k.key}
												label={`Copy the key for ${k.service}`}
												wrap
											/>
										</li>
									))}
								</ul>
							</div>
						</div>
					</section>
				)}
				<Warnings warnings={result.warnings} />
				{result.changes.length > 0 && (
					<PlanChanges changes={result.changes} project={project} />
				)}
			</div>
			<div className="mt-8 flex justify-end border-t pt-5">
				<Button asChild size="lg">
					<Link to="/projects/$projectId" params={{ projectId: project.id }}>
						Done
					</Link>
				</Button>
			</div>
		</Page>
	);
}

function ImportManifest() {
	const { projectId } = Route.useParams();
	const { step, env } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: project } = useProject(projectId);
	const [values, setValues] = useState<V | null>(null);
	const [result, setResult] = useState<ApplyResult | null>(null);

	// The wizard owns its answers; the plan step mirrors them here to drive the dry run.
	const scope = project && values ? scopeOf(values, project) : null;
	const apply = useApplyManifest();
	const { reset } = apply;
	// Backup keys live only in this component's state: drop the mutation cache's copy on leave.
	useEffect(() => reset, [reset]);

	const plan = useQuery({
		queryKey: ["manifest-plan", scope, values?.manifest, values?.prune],
		queryFn: () =>
			manifestApi.apply(scope as ManifestScope, {
				manifest: values?.manifest ?? "",
				prune: values?.prune ?? false,
				dryRun: true,
			}),
		enabled: step === "plan" && scope !== null && !result,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
	});

	const steps = useMemo<WizardStep<V>[]>(() => {
		if (!project) return [];
		return [
			{
				id: "source",
				title: "Manifest",
				description:
					"A project manifest converges the whole project; an environment manifest converges one environment. Secret values are never exported, so stored secrets are kept.",
				schema: (v) =>
					manifestKind(v.manifest) === "environment"
						? z.object({
								manifest: manifestField,
								target: z
									.string()
									.min(1, "Choose the environment to apply it to."),
							})
						: z.object({ manifest: manifestField }),
				render: (w) => <SourceStep w={w} project={project} />,
			},
			{
				id: "plan",
				title: "Review changes",
				description:
					"A dry run against what is deployed now. Services, domains and backups are matched by slug, hostname and schedule.",
				ready: () =>
					plan.data
						? plan.data.changes.length > 0 || "Already up to date"
						: plan.error
							? "Fix the manifest to continue"
							: "Planning…",
				render: (w) => (
					<Mirror w={w} onValues={setValues}>
						<PlanStep w={w} project={project} plan={plan} />
					</Mirror>
				),
			},
		];
	}, [project, plan]);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);

	if (!project) return null;
	if (result) return <Applied result={result} project={project} />;

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Import manifest"
				description={`Apply a LogiStack manifest to ${project.name}. You review every change before anything is written.`}
			/>
			<Wizard
				id={`import-manifest-${projectId}`}
				steps={steps}
				defaultValues={{
					manifest: "",
					fileName: "",
					target: env ?? "",
					prune: false,
				}}
				secretKeys={["manifest", "fileName", "prune"]}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Apply changes"
				onComplete={async (v) => {
					const target = scopeOf(v, project);
					if (!target) throw new Error("Choose what the manifest applies to.");
					const res = await apply.mutateAsync({
						scope: target,
						manifest: v.manifest,
						prune: v.prune,
					});
					reset();
					setResult(res);
					toast.success("Manifest applied");
				}}
			/>
		</Page>
	);
}

/** Lifts the wizard's answers to the route, where the dry-run query lives. */
function Mirror({
	w,
	onValues,
	children,
}: {
	w: WizardApi<V>;
	onValues: (v: V) => void;
	children: ReactNode;
}) {
	const { values } = w;
	useEffect(() => onValues(values), [values, onValues]);
	return children;
}
