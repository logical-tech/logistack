import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { GitPullRequest, Globe, Plus, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import {
	type PreviewSettings,
	useSavePreviewSettings,
} from "@/lib/api/previews";
import { projectQuery } from "@/lib/api/projects";
import { servicesQuery } from "@/lib/api/services";

type Variable = { key: string; value: string; secret: boolean; kept: boolean };

type V = {
	projectId: string;
	sourceEnvironmentId: string;
	services: string[];
	domains: "generated" | "pattern";
	domainPattern: string;
	variables: Variable[];
	maxPreviews: string;
	ttlHours: string;
	allowForks: boolean;
	enabled: boolean;
};

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function defaults(projectId: string, s: PreviewSettings | null): V {
	return {
		projectId,
		sourceEnvironmentId: s?.sourceEnvironmentId ?? "",
		services: s?.services ?? [],
		domains: s?.domainPattern ? "pattern" : "generated",
		domainPattern: s?.domainPattern ?? "pr-{number}.{wildcard}",
		variables: (s?.variables ?? []).map((v) => ({
			key: v.key,
			value: v.value ?? "",
			secret: v.secret ?? true,
			kept: v.secret === true && v.value === undefined,
		})),
		maxPreviews: String(s?.maxPreviews ?? 5),
		ttlHours: String(s?.ttlHours ?? 72),
		allowForks: s?.allowForks ?? false,
		enabled: s?.enabled ?? true,
	};
}

/** Fills the pattern the way the server does, for the live example. */
const example = (pattern: string, service: string) =>
	pattern
		.toLowerCase()
		.replaceAll("{number}", "42")
		.replaceAll("{service}", service)
		.replaceAll("{wildcard}", "your-wildcard.example.com");

const whole = (min: number, max: number, what: string) =>
	z
		.string()
		.regex(/^\d+$/, `Use a whole number of ${what}.`)
		.refine(
			(n) => Number(n) >= min && Number(n) <= max,
			`Between ${min} and ${max} ${what}.`,
		);

function SourceStep({ w }: { w: WizardApi<V> }) {
	const { data: project } = useQuery(projectQuery(w.values.projectId));
	const envs = project?.environments.filter((e) => !e.preview) ?? [];
	const { data: services } = useQuery({
		...servicesQuery(w.values.sourceEnvironmentId),
		enabled: Boolean(w.values.sourceEnvironmentId),
	});
	const git = services?.filter(
		(s) => s.spec.kind === "application" && s.spec.source.type === "git",
	);
	const toggle = (slug: string, on: boolean) =>
		w.set(
			"services",
			on
				? [...w.values.services, slug]
				: w.values.services.filter((s) => s !== slug),
		);
	return (
		<div className="grid gap-6">
			<Field
				id="wz-sourceEnvironmentId"
				label="Clone from"
				error={w.error("sourceEnvironmentId")}
				hint="Every preview starts as a copy of this environment's services, stacks and variables. Its volumes and databases are never shared: each preview gets empty ones."
			>
				<Select
					value={w.values.sourceEnvironmentId || undefined}
					onValueChange={(id) => {
						w.set("sourceEnvironmentId", id);
						w.set("services", []);
					}}
				>
					<SelectTrigger
						id="wz-sourceEnvironmentId"
						className="w-full"
						aria-invalid={w.error("sourceEnvironmentId") ? true : undefined}
						aria-describedby="wz-sourceEnvironmentId-msg"
					>
						<SelectValue placeholder="Choose an environment" />
					</SelectTrigger>
					<SelectContent>
						{envs.map((e) => (
							<SelectItem key={e.id} value={e.id}>
								{e.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
			{w.values.sourceEnvironmentId && (
				<fieldset className="grid gap-2" aria-describedby="wz-services-msg">
					<legend className="mb-2 text-sm font-medium">
						Services that build the pull request
					</legend>
					{git?.length === 0 && (
						<p className="rounded-lg bg-muted/60 px-4 py-3 text-sm text-muted-foreground dark:bg-muted/40">
							No service here builds from a Git repository, so there is nothing
							a pull request could change.
						</p>
					)}
					{git?.map((s) => {
						const id = `wz-svc-${s.id}`;
						const source = s.spec.kind === "application" ? s.spec.source : null;
						return (
							<label
								key={s.id}
								htmlFor={id}
								className="flex items-center gap-3 rounded-lg bg-card px-4 py-3 text-sm ring-1 ring-border"
							>
								<Checkbox
									id={id}
									checked={w.values.services.includes(s.slug)}
									onCheckedChange={(c) => toggle(s.slug, c === true)}
								/>
								<span className="min-w-0 flex-1">
									<span className="block font-medium">{s.name}</span>
									{source?.type === "git" && (
										<span className="block truncate font-mono text-xs text-muted-foreground">
											{source.repository}#{source.branch}
										</span>
									)}
								</span>
							</label>
						);
					})}
					<p
						id="wz-services-msg"
						aria-live="polite"
						className={
							w.error("services")
								? "text-xs text-bad-text"
								: "text-xs text-muted-foreground"
						}
					>
						{w.error("services") ??
							"These build the pull request's head commit; the others run what the source runs. Pull requests on their repository open previews."}
					</p>
				</fieldset>
			)}
		</div>
	);
}

function DomainsStep({ w }: { w: WizardApi<V> }) {
	return (
		<div className="grid gap-5">
			<ChoiceGroup
				label="Preview hostnames"
				columns={2}
				value={w.values.domains}
				onChange={(d) => w.set("domains", d)}
				choices={[
					{
						value: "generated",
						title: "Generated",
						description:
							"Each service gets an sslip.io or wildcard hostname of its own. Nothing to configure.",
						icon: Globe,
					},
					{
						value: "pattern",
						title: "A pattern",
						description:
							"Readable hosts like pr-42.preview.example.com, on a domain you point at this server.",
						icon: GitPullRequest,
					},
				]}
			/>
			{w.values.domains === "pattern" && (
				<Field
					id="wz-domainPattern"
					label="Pattern"
					error={w.error("domainPattern")}
					hint={
						<>
							<code className="font-mono">{"{number}"}</code> is the pull
							request, <code className="font-mono">{"{service}"}</code> the
							service and <code className="font-mono">{"{wildcard}"}</code> the
							instance's custom wildcard. Without{" "}
							<code className="font-mono">{"{service}"}</code>, the first
							service takes the host and the rest get generated ones. For #42:{" "}
							<span className="whitespace-nowrap font-mono text-foreground">
								{example(w.values.domainPattern, "web")}
							</span>
						</>
					}
				>
					<Input
						{...w.bind("domainPattern")}
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
						placeholder="pr-{number}.{wildcard}"
					/>
				</Field>
			)}
		</div>
	);
}

function VariablesStep({ w }: { w: WizardApi<V> }) {
	const vars = w.values.variables;
	const edit = (i: number, patch: Partial<Variable>) =>
		w.set(
			"variables",
			vars.map((v, j) => (j === i ? { ...v, ...patch } : v)),
		);
	return (
		<div className="grid gap-3">
			{vars.length === 0 && (
				<p className="rounded-lg bg-muted/60 px-4 py-3 text-sm text-muted-foreground dark:bg-muted/40">
					Previews run with the source's variables. Override the ones that must
					differ, like a test payment key or a public URL.
				</p>
			)}
			{vars.map((v, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until a key is typed.
					key={i}
					className="grid items-center gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto_auto]"
				>
					<Input
						aria-label={`Variable ${i + 1} name`}
						value={v.key}
						onChange={(e) => edit(i, { key: e.target.value })}
						placeholder="STRIPE_KEY"
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
					/>
					<Input
						aria-label={`Variable ${i + 1} value`}
						type={v.secret ? "password" : "text"}
						value={v.value}
						onChange={(e) => edit(i, { value: e.target.value, kept: false })}
						placeholder={v.kept ? "Stored; type to replace" : "Value"}
						autoComplete="off"
						spellCheck={false}
						className="font-mono"
					/>
					<label
						htmlFor={`wz-var-secret-${i}`}
						className="flex items-center gap-2 text-sm text-muted-foreground"
					>
						<Switch
							id={`wz-var-secret-${i}`}
							checked={v.secret}
							onCheckedChange={(c) => edit(i, { secret: c, kept: false })}
						/>
						Secret
					</label>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={`Remove variable ${v.key || i + 1}`}
						onClick={() =>
							w.set(
								"variables",
								vars.filter((_, j) => j !== i),
							)
						}
					>
						<X />
					</Button>
				</div>
			))}
			<p
				id="wz-variables-msg"
				aria-live="polite"
				className={w.error("variables") ? "text-xs text-bad-text" : "sr-only"}
			>
				{w.error("variables")}
			</p>
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="justify-self-start"
				onClick={() =>
					w.set("variables", [
						...vars,
						{ key: "", value: "", secret: true, kept: false },
					])
				}
			>
				<Plus data-icon="inline-start" />
				Add variable
			</Button>
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
				<span className="text-muted-foreground">{body}</span>
			</span>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</label>
	);
}

function LimitsStep({ w }: { w: WizardApi<V> }) {
	return (
		<div className="grid gap-6">
			<div className="grid gap-5 sm:grid-cols-2">
				<Field
					id="wz-maxPreviews"
					label="At most"
					error={w.error("maxPreviews")}
					hint="A pull request opened past the limit gets no preview until one closes."
				>
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Input
							{...w.bind("maxPreviews")}
							inputMode="numeric"
							className="w-20 tabular"
						/>
						previews at once
					</div>
				</Field>
				<Field
					id="wz-ttlHours"
					label="Remove after"
					error={w.error("ttlHours")}
					hint="Counted from the last commit. Closing or merging removes it at once."
				>
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Input
							{...w.bind("ttlHours")}
							inputMode="numeric"
							className="w-20 tabular"
						/>
						hours without a commit
					</div>
				</Field>
			</div>
			<div className="grid gap-2">
				<ToggleRow
					id="wz-allowForks"
					title="Preview pull requests from forks"
					body="Off is the safe choice for public repositories."
					checked={w.values.allowForks}
					onChange={(c) => w.set("allowForks", c)}
				/>
				{w.values.allowForks && (
					<div
						role="note"
						className="flex gap-3 rounded-lg bg-warn/10 p-4 text-sm ring-1 ring-warn/30"
					>
						<ShieldAlert
							className="mt-0.5 size-4 shrink-0 text-warn-text"
							aria-hidden
						/>
						<div className="grid gap-1">
							<p className="font-medium text-warn-text">
								Anyone who can fork the repository can run code here
							</p>
							<p className="text-pretty text-muted-foreground">
								A fork's pull request is built and started with the preview's
								variables, secrets included. Its author can read every one of
								them, and use the server's network. Only allow this when every
								fork author is trusted.
							</p>
						</div>
					</div>
				)}
				<ToggleRow
					id="wz-enabled"
					title="Previews on"
					body="Turning them off stops new previews; running ones stay until their pull request closes."
					checked={w.values.enabled}
					onChange={(c) => w.set("enabled", c)}
				/>
			</div>
		</div>
	);
}

const STEPS: WizardStep<V>[] = [
	{
		id: "source",
		title: "What a preview runs",
		description:
			"Each pull request gets its own environment, pr-<number>, listed with the project's environments.",
		schema: z.object({
			sourceEnvironmentId: z
				.string()
				.min(1, "Choose the environment to clone."),
			services: z.array(z.string()).min(1, "Choose at least one service."),
		}),
		render: (w) => <SourceStep w={w} />,
	},
	{
		id: "domains",
		title: "Where it is reached",
		description:
			"Every service the source exposes on a domain gets one in the preview. The URL is posted on the pull request.",
		schema: (v) =>
			v.domains === "pattern"
				? z.object({
						domainPattern: z
							.string()
							.trim()
							.min(1, "Write a pattern.")
							.refine((p) => p.includes("{number}"), {
								message:
									"Include {number}, so each pull request gets its own host.",
							})
							.refine((p) => /^[a-z0-9.{}-]+$/i.test(p), {
								message: "Use letters, digits, dots, dashes and the tokens.",
							}),
					})
				: z.object({}),
		render: (w) => <DomainsStep w={w} />,
	},
	{
		id: "variables",
		title: "Variables",
		description: "These win over every definition in the source environment.",
		schema: z.object({
			variables: z
				.array(
					z.object({ key: z.string(), value: z.string(), kept: z.boolean() }),
				)
				.refine((vs) => vs.every((v) => ENV_KEY.test(v.key)), {
					message:
						"Names use letters, digits and underscores, and don't start with a digit.",
				})
				.refine((vs) => vs.every((v) => v.kept || v.value !== ""), {
					message: "Give every variable a value.",
				})
				.refine((vs) => new Set(vs.map((v) => v.key)).size === vs.length, {
					message: "Each name once.",
				}),
		}),
		render: (w) => <VariablesStep w={w} />,
	},
	{
		id: "limits",
		title: "Limits and safety",
		schema: z.object({
			maxPreviews: whole(1, 50, "previews"),
			ttlHours: whole(1, 2160, "hours"),
		}),
		render: (w) => <LimitsStep w={w} />,
	},
	{
		id: "review",
		title: "Review",
		render: (w) => {
			const v = w.values;
			return (
				<Summary
					w={w}
					sections={[
						{
							stepId: "source",
							title: "What a preview runs",
							rows: [
								{
									label: "Clone from",
									value: <EnvName w={w} />,
								},
								{ label: "Follow the PR", value: v.services.join(", ") },
							],
						},
						{
							stepId: "domains",
							title: "Where it is reached",
							rows: [
								{
									label: "Hostnames",
									value:
										v.domains === "pattern" ? (
											<span className="font-mono text-xs">
												{v.domainPattern}
											</span>
										) : (
											"Generated"
										),
								},
							],
						},
						{
							stepId: "variables",
							title: "Variables",
							rows: [
								{
									label: "Overrides",
									value: v.variables.length
										? v.variables.map((x) => x.key).join(", ")
										: "None",
								},
							],
						},
						{
							stepId: "limits",
							title: "Limits and safety",
							rows: [
								{ label: "At most", value: `${v.maxPreviews} at once` },
								{
									label: "Removed after",
									value: `${v.ttlHours} hours without a commit`,
								},
								{
									label: "Forks",
									value: v.allowForks ? "Previewed" : "Refused",
								},
								{ label: "State", value: v.enabled ? "On" : "Off" },
							],
						},
					]}
				/>
			);
		},
	},
];

function EnvName({ w }: { w: WizardApi<V> }) {
	const { data: project } = useQuery(projectQuery(w.values.projectId));
	return (
		project?.environments.find((e) => e.id === w.values.sourceEnvironmentId)
			?.name ?? "None"
	);
}

export function PreviewWizard({
	projectId,
	settings,
	step,
	onStepChange,
}: {
	projectId: string;
	settings: PreviewSettings | null;
	step: string | undefined;
	onStepChange: (id: string, opts: { replace: boolean }) => void;
}) {
	const navigate = useNavigate();
	const save = useSavePreviewSettings(projectId);
	return (
		<Wizard
			id={`previews:${projectId}`}
			steps={STEPS}
			defaultValues={defaults(projectId, settings)}
			secretKeys={["variables"]}
			step={step}
			onStepChange={onStepChange}
			finishLabel={settings ? "Save changes" : "Turn on previews"}
			onComplete={async (v) => {
				await save.mutateAsync({
					enabled: v.enabled,
					sourceEnvironmentId: v.sourceEnvironmentId,
					services: v.services,
					domainPattern:
						v.domains === "pattern" ? v.domainPattern.trim() : null,
					variables: v.variables.map((x) => ({
						key: x.key,
						secret: x.secret,
						...(!x.kept && { value: x.value }),
					})),
					maxPreviews: Number(v.maxPreviews),
					ttlHours: Number(v.ttlHours),
					allowForks: v.allowForks,
				});
				toast.success(v.enabled ? "Previews are on" : "Previews saved", {
					description: v.enabled
						? "The next pull request on a followed repository opens one."
						: "No new previews open until you turn them on.",
				});
				await navigate({ to: "/projects/$projectId", params: { projectId } });
			}}
		/>
	);
}
