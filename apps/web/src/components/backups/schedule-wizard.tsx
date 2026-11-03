import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Box, Container, Server, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
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
import { meQuery } from "@/lib/api/access";
import {
	type Schedule,
	type ScheduleInput,
	useCreateSchedule,
	useUpdateSchedule,
} from "@/lib/api/backups";
import { nodesQuery } from "@/lib/api/monitoring";
import { projectQuery, projectsQuery } from "@/lib/api/projects";
import { servicesQuery } from "@/lib/api/services";
import { browserTimezone, cronError, describeCron } from "@/lib/cron";
import { formatDuration } from "@/lib/format";
import { CronField } from "./cron-field";
import { TargetLabel } from "./schedule-parts";
import { ScriptEditor } from "./script-editor";

type TargetKind = ScheduleInput["target"] extends infer T
	? T extends { kind: infer K }
		? K & string
		: never
	: never;
type Concurrency = NonNullable<ScheduleInput["concurrency"]>;

type V = {
	name: string;
	/** `ORG` for an organization-wide schedule. */
	projectId: string;
	cron: string;
	timezone: string;
	targetKind: TargetKind;
	image: string;
	serviceId: string;
	nodeId: string;
	script: string;
	timeoutMin: string;
	concurrency: Concurrency;
	notifyOnFailure: boolean;
	enabled: boolean;
};

const ORG = "__org";

const STARTER = `#!/bin/sh
set -eu

echo "Running on $(hostname) at $(date -u +%FT%TZ)"
`;

const CONCURRENCY: {
	value: Concurrency;
	title: string;
	description: string;
}[] = [
	{
		value: "forbid",
		title: "Skip if still running",
		description:
			"The next tick is recorded as skipped while a run is going. Safest for jobs that write.",
	},
	{
		value: "allow",
		title: "Run in parallel",
		description:
			"Every tick starts a run, even if earlier ones are still going.",
	},
	{
		value: "replace",
		title: "Replace the running one",
		description:
			"The running job is stopped and marked cancelled; the new run starts.",
	},
];

const isAdmin = (roles: string[] | undefined) =>
	!!roles?.some((r) => r === "owner" || r === "admin");

function defaults(s?: Schedule): V {
	const t = s?.target;
	return {
		name: s?.name ?? "",
		projectId: s?.projectId ?? ORG,
		cron: s?.cron ?? "0 3 * * *",
		timezone: s?.timezone ?? browserTimezone(),
		targetKind: t?.kind ?? "ephemeral",
		image: t?.kind === "ephemeral" ? t.image : "alpine:3.22",
		serviceId: t?.kind === "service" ? t.serviceId : "",
		nodeId: t?.kind === "host" ? t.nodeId : "",
		script: s?.script ?? STARTER,
		timeoutMin: String(Math.max(1, Math.round((s?.timeoutS ?? 3600) / 60))),
		concurrency: s?.concurrency ?? "forbid",
		notifyOnFailure: s?.notifyOnFailure ?? true,
		enabled: s?.enabled ?? true,
	};
}

function toInput(v: V): ScheduleInput {
	const target =
		v.targetKind === "service"
			? { kind: "service" as const, serviceId: v.serviceId }
			: v.targetKind === "host"
				? { kind: "host" as const, nodeId: v.nodeId }
				: { kind: "ephemeral" as const, image: v.image.trim() };
	return {
		name: v.name.trim(),
		projectId: v.projectId === ORG ? null : v.projectId,
		cron: v.cron.trim(),
		timezone: v.timezone,
		script: v.script,
		target,
		timeoutS: Number(v.timeoutMin) * 60,
		concurrency: v.concurrency,
		notifyOnFailure: v.notifyOnFailure,
		enabled: v.enabled,
	};
}

const IMAGE = /^[a-z0-9]+([._/:@-][a-z0-9._-]+)*$/i;

function ProjectSelect({
	w,
	allowOrg,
}: {
	w: WizardApi<V>;
	allowOrg: boolean;
}) {
	const { data: projects } = useQuery(projectsQuery);
	return (
		<Select
			value={w.values.projectId}
			onValueChange={(id) => {
				w.set("projectId", id);
				w.set("serviceId", "");
			}}
		>
			<SelectTrigger
				id="wz-projectId"
				className="w-full"
				aria-invalid={w.error("projectId") ? true : undefined}
				aria-describedby="wz-projectId-msg"
			>
				<SelectValue placeholder="Choose a project" />
			</SelectTrigger>
			<SelectContent>
				{allowOrg && (
					<SelectItem value={ORG}>None, the whole organization</SelectItem>
				)}
				{projects?.map((p) => (
					<SelectItem key={p.id} value={p.id}>
						{p.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** Services of one project grouped by environment; names repeat across environments. */
function ServiceSelect({ w }: { w: WizardApi<V> }) {
	const projectId = w.values.projectId;
	const { data: project } = useQuery({
		...projectQuery(projectId),
		enabled: projectId !== ORG,
	});
	const envs = project?.environments ?? [];
	const lists = useQueries({
		queries: envs.map((e) => ({
			...servicesQuery(e.id),
			refetchInterval: false as const,
		})),
	});
	return (
		<Select
			value={w.values.serviceId || undefined}
			onValueChange={(id) => w.set("serviceId", id)}
			disabled={projectId === ORG}
		>
			<SelectTrigger
				id="wz-serviceId"
				className="w-full"
				aria-invalid={w.error("serviceId") ? true : undefined}
				aria-describedby="wz-serviceId-msg"
			>
				<SelectValue
					placeholder={
						projectId === ORG ? "Choose a project first" : "Choose a service"
					}
				/>
			</SelectTrigger>
			<SelectContent>
				{envs.map((e, i) => (
					<SelectGroup key={e.id}>
						<SelectLabel>{e.name}</SelectLabel>
						{lists[i]?.data?.map((s) => (
							<SelectItem key={s.id} value={s.id}>
								{s.name}
								<span className="text-muted-foreground">
									{s.kind === "database" ? "database" : "app"}
								</span>
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}

function NodeSelect({ w }: { w: WizardApi<V> }) {
	const { data: nodes } = useQuery(nodesQuery);
	return (
		<Select
			value={w.values.nodeId || undefined}
			onValueChange={(id) => w.set("nodeId", id)}
		>
			<SelectTrigger
				id="wz-nodeId"
				className="w-full"
				aria-invalid={w.error("nodeId") ? true : undefined}
				aria-describedby="wz-nodeId-msg"
			>
				<SelectValue placeholder="Choose a node" />
			</SelectTrigger>
			<SelectContent>
				{nodes?.map((n) => (
					<SelectItem key={n.id} value={n.id}>
						<span className="font-mono text-xs">{n.hostname}</span>
						<span className="text-muted-foreground">{n.role}</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function TargetStep({ w }: { w: WizardApi<V> }) {
	const { data: me } = useQuery(meQuery);
	const admin = isAdmin(me?.roles);
	const v = w.values;
	return (
		<div className="grid gap-5">
			<ChoiceGroup
				label="Where the script runs"
				columns={1}
				value={v.targetKind}
				onChange={(k) => w.set("targetKind", k)}
				choices={[
					{
						value: "ephemeral",
						title: "A fresh container",
						description:
							"Pulled from an image, started for this run and removed after. Nothing it writes survives.",
						icon: Box,
					},
					{
						value: "service",
						title: "Inside a service",
						description:
							"Runs in a running replica, with the service's environment, network and volumes.",
						icon: Container,
					},
					...(admin || v.targetKind === "host"
						? [
								{
									value: "host" as const,
									title: "On a node's host",
									description:
										"A root shell on the machine itself, outside every container.",
									icon: Server,
									badge: "Admins only",
								},
							]
						: []),
				]}
			/>
			{!admin && (
				<p className="text-xs text-muted-foreground">
					Running on a node's host is limited to organization admins.
				</p>
			)}
			{v.targetKind === "ephemeral" && (
				<Field
					id="wz-image"
					label="Image"
					error={w.error("image")}
					hint="Pin a tag. The script runs with /bin/sh, so the image needs a shell."
				>
					<Input
						{...w.bind("image")}
						placeholder="alpine:3.22"
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
					/>
				</Field>
			)}
			{v.targetKind === "service" && (
				<div className="grid gap-5 sm:grid-cols-2">
					<Field id="wz-projectId" label="Project" error={w.error("projectId")}>
						<ProjectSelect w={w} allowOrg={false} />
					</Field>
					<Field
						id="wz-serviceId"
						label="Service"
						error={w.error("serviceId")}
						hint="With several replicas, one is picked per run."
					>
						<ServiceSelect w={w} />
					</Field>
				</div>
			)}
			{v.targetKind === "host" && (
				<>
					<div
						role="note"
						className="flex gap-3 rounded-lg bg-warn/10 p-4 text-sm ring-1 ring-warn/30"
					>
						<TriangleAlert
							className="mt-0.5 size-4 shrink-0 text-warn-text"
							aria-hidden
						/>
						<div className="grid gap-1">
							<p className="font-medium text-warn-text">
								This runs as root on the node, outside Docker
							</p>
							<p className="text-muted-foreground">
								A mistake here can stop every service on the machine or remove
								data no backup covers. Prefer a fresh container unless the job
								needs the host itself, like rotating logs or pruning images.
							</p>
						</div>
					</div>
					<Field id="wz-nodeId" label="Node" error={w.error("nodeId")}>
						<NodeSelect w={w} />
					</Field>
				</>
			)}
		</div>
	);
}

const STEPS: WizardStep<V>[] = [
	{
		id: "name",
		title: "Name it",
		description: "The name shows up in run history and failure notifications.",
		schema: z.object({
			name: z.string().trim().min(1, "Give the schedule a name.").max(100),
		}),
		render: (w) => (
			<div className="grid gap-5">
				<Field id="wz-name" label="Name" error={w.error("name")}>
					<Input
						{...w.bind("name")}
						placeholder="Nightly VACUUM ANALYZE"
						autoComplete="off"
						autoFocus
					/>
				</Field>
				<Field
					id="wz-projectId"
					label="Project"
					hint="People with access to the project can see and run it. Without one, only organization members can."
				>
					<ProjectSelect w={w} allowOrg />
				</Field>
			</div>
		),
	},
	{
		id: "when",
		title: "When it runs",
		description:
			"Five cron fields. The preview shows the next runs in the chosen zone.",
		schema: z.object({
			cron: z
				.string()
				.refine((c) => !cronError(c), { message: "Fix the cron expression." }),
		}),
		render: (w) => (
			<CronField
				id="wz-cron"
				label="Runs"
				cron={w.values.cron}
				timezone={w.values.timezone}
				onCron={(c) => w.set("cron", c)}
				onTimezone={(tz) => w.set("timezone", tz)}
				error={w.error("cron")}
			/>
		),
	},
	{
		id: "target",
		title: "Where it runs",
		description:
			"Each run starts clean; only the output and exit code are kept.",
		schema: (v) =>
			v.targetKind === "service"
				? z.object({
						projectId: z.string().refine((p) => p !== ORG, "Choose a project."),
						serviceId: z.string().min(1, "Choose a service."),
					})
				: v.targetKind === "host"
					? z.object({ nodeId: z.string().min(1, "Choose a node.") })
					: z.object({
							image: z
								.string()
								.trim()
								.regex(IMAGE, "Use an image reference like alpine:3.22."),
						}),
		render: (w) => <TargetStep w={w} />,
	},
	{
		id: "script",
		title: "Script",
		description: "Runs with /bin/sh. Output is kept up to 1 MiB per run.",
		schema: z.object({
			script: z
				.string()
				.refine((s) => s.trim().length > 0, "Write the script to run.")
				.refine((s) => s.length <= 64 * 1024, "Keep the script under 64 KiB."),
		}),
		render: (w) => (
			<div className="grid gap-2">
				<ScriptEditor
					id="wz-script"
					value={w.values.script}
					onChange={(s) => w.set("script", s)}
					invalid={!!w.error("script")}
					describedBy="wz-script-msg"
					className="h-80 sm:h-96"
				/>
				<p
					id="wz-script-msg"
					aria-live="polite"
					className={
						w.error("script")
							? "text-xs text-bad-text"
							: "text-xs text-muted-foreground"
					}
				>
					{w.error("script") ??
						(w.values.targetKind === "service"
							? "The service's environment variables, secrets included, are set."
							: "Tab indents. Press Escape, then Tab, to move on.")}
				</p>
			</div>
		),
	},
	{
		id: "options",
		title: "Limits and alerts",
		schema: z.object({
			timeoutMin: z
				.string()
				.regex(/^\d+$/, "Use whole minutes.")
				.refine(
					(n) => Number(n) >= 1 && Number(n) <= 1440,
					"Between 1 and 1440 minutes.",
				),
		}),
		render: (w) => (
			<div className="grid gap-6">
				<Field
					id="wz-timeoutMin"
					label="Timeout"
					error={w.error("timeoutMin")}
					hint="A run still going after this is stopped and marked failed."
				>
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						Stop after
						<Input
							{...w.bind("timeoutMin")}
							inputMode="numeric"
							className="w-20 tabular"
						/>
						minutes
					</div>
				</Field>
				<div className="grid gap-2">
					<span className="text-sm font-medium">When a run is still going</span>
					<ChoiceGroup
						label="When a run is still going"
						columns={1}
						value={w.values.concurrency}
						onChange={(c) => w.set("concurrency", c)}
						choices={CONCURRENCY}
					/>
				</div>
				<div className="grid gap-2">
					<ToggleRow
						id="wz-notifyOnFailure"
						title="Notify on failure"
						body="Failed runs reach the channels whose rules include schedule failures."
						checked={w.values.notifyOnFailure}
						onChange={(c) => w.set("notifyOnFailure", c)}
					/>
					<ToggleRow
						id="wz-enabled"
						title="Enabled"
						body="Paused schedules keep their history and can still be run by hand."
						checked={w.values.enabled}
						onChange={(c) => w.set("enabled", c)}
					/>
				</div>
			</div>
		),
	},
	{
		id: "review",
		title: "Review",
		render: (w) => {
			const v = w.values;
			const input = toInput(v);
			return (
				<Summary
					w={w}
					sections={[
						{
							stepId: "name",
							title: v.name.trim() || "Schedule",
							rows: [
								{
									label: "Project",
									value: <ProjectName id={input.projectId ?? null} />,
								},
							],
						},
						{
							stepId: "when",
							title: "When",
							rows: [
								{
									label: "Runs",
									value: describeCron(v.cron) ?? (
										<span className="font-mono text-xs">{v.cron}</span>
									),
								},
								{
									label: "Cron",
									value: <span className="font-mono text-xs">{v.cron}</span>,
								},
								{ label: "Time zone", value: v.timezone.replaceAll("_", " ") },
							],
						},
						{
							stepId: "target",
							title: "Where",
							rows: [
								{
									label: "Target",
									value: input.target && <TargetLabel target={input.target} />,
								},
							],
						},
						{
							stepId: "script",
							title: "Script",
							rows: [
								{
									label: "Length",
									value: `${v.script.split("\n").length} lines`,
								},
							],
						},
						{
							stepId: "options",
							title: "Limits and alerts",
							rows: [
								{
									label: "Timeout",
									value: formatDuration(Number(v.timeoutMin) * 60),
								},
								{
									label: "Overlap",
									value: CONCURRENCY.find((c) => c.value === v.concurrency)
										?.title,
								},
								{
									label: "On failure",
									value: v.notifyOnFailure ? "Notify" : "Stay quiet",
								},
								{ label: "State", value: v.enabled ? "Enabled" : "Paused" },
							],
						},
					]}
				/>
			);
		},
	},
];

function ProjectName({ id }: { id: string | null }) {
	const { data: projects } = useQuery(projectsQuery);
	if (!id) return "Whole organization";
	return projects?.find((p) => p.id === id)?.name ?? id;
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

/** One wizard for creating and editing; `schedule` switches it to edit. */
export function ScheduleWizard({
	schedule,
	step,
	onStepChange,
}: {
	schedule?: Schedule;
	step: string | undefined;
	onStepChange: (id: string, opts: { replace: boolean }) => void;
}) {
	const navigate = useNavigate();
	const create = useCreateSchedule();
	const update = useUpdateSchedule();
	return (
		<Wizard
			id={schedule ? `edit-schedule:${schedule.id}` : "new-schedule"}
			steps={STEPS}
			defaultValues={defaults(schedule)}
			step={step}
			onStepChange={onStepChange}
			finishLabel={schedule ? "Save changes" : "Create schedule"}
			onComplete={async (v) => {
				const input = toInput(v);
				const saved = schedule
					? await update.mutateAsync({ id: schedule.id, ...input })
					: await create.mutateAsync(input);
				toast.success(
					schedule ? `${saved.name} saved` : `${saved.name} created`,
					{
						description: saved.nextRunAt
							? `Next run ${new Date(saved.nextRunAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.`
							: "Paused. Run it by hand from its page.",
					},
				);
				await navigate({
					to: "/schedules/$scheduleId",
					params: { scheduleId: saved.id },
				});
			}}
		/>
	);
}
