import type {
	TaskTemplate,
	TemplatePayload,
	WorkTemplate,
	WorkTemplateInstantiateResult,
} from "@logistack/contracts";
import { CalendarArrowDown, CalendarArrowUp, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import {
	useInstantiateWorkTemplate,
	useWorkFields,
	useWorkLists,
	useWorkPeople,
	useWorkProjects,
	useWorkTemplate,
	useWorkTemplates,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { WizardDialog } from "./template-dialog";

type Values = {
	templateId: string;
	projectId: string;
	listId: string;
	date: string;
	mode: "start" | "finish";
	placeholders: Record<string, string>;
	missingFields: "create" | "drop";
};

function walk(p: TemplatePayload | undefined): TaskTemplate[] {
	const out: TaskTemplate[] = [];
	const go = (ts: readonly TaskTemplate[]) => {
		for (const t of ts) {
			out.push(t);
			go(t.subtasks);
		}
	};
	go(p?.tasks ?? []);
	for (const l of p?.lists ?? []) go(l.tasks);
	return out;
}

const placeholdersOf = (p: TemplatePayload | undefined) => [
	...new Set(
		walk(p).flatMap((t) =>
			[
				...t.assigneeRefs,
				...t.checklist.flatMap((c) => (c.assigneeRef ? [c.assigneeRef] : [])),
			].flatMap((r) =>
				typeof r === "object" && "placeholder" in r ? [r.placeholder] : [],
			),
		),
	),
];

/** Field refs the template sets that the target project has no field for (matched by name). */
function missingFieldsOf(
	p: TemplatePayload | undefined,
	targetNames: readonly string[],
): string[] {
	const have = new Set(targetNames.map((n) => n.toLowerCase()));
	const name = (ref: string) =>
		p?.fields?.find((f) => f.ref === ref)?.name ?? ref;
	return [
		...new Set(
			walk(p).flatMap((t) => t.fieldValues.map((f) => name(f.fieldRef))),
		),
	].filter((n) => !have.has(n.toLowerCase()));
}

const today = () => new Date().toISOString().slice(0, 10);

/** "New from template": pick → target → anchor date → people → fields → summary (dry run) → create. */
export function NewFromTemplateWizard({
	projectId: initialProject,
	listId: initialList,
	open,
	onOpenChange,
	onCreated,
}: {
	/** Preselects the target; templates of this project are listed beside org-wide ones. */
	projectId?: string;
	listId?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated?: (result: WorkTemplateInstantiateResult) => void;
}) {
	const [step, setStep] = useState<string>();
	const [values, setValues] = useState<Values | null>(null);
	const { data: tpl } = useWorkTemplate(values?.templateId ?? "");
	const { data: fields = [] } = useWorkFields(values?.projectId ?? "");
	const instantiate = useInstantiateWorkTemplate();
	const placeholders = placeholdersOf(tpl?.payload);
	const missing = missingFieldsOf(
		tpl?.payload,
		fields.map((f) => f.name),
	);

	const raw: WizardStep<Values>[] = [
		{
			id: "pick",
			title: "Pick a template",
			schema: z.object({ templateId: z.string().min(1, "Pick a template") }),
			render: (w) => <PickStep w={w} projectId={initialProject} />,
		},
		{
			id: "target",
			title: "Where",
			description:
				tpl?.kind === "project"
					? "A project template adds its statuses, fields, tags and lists to the project."
					: "Tasks are created in this list.",
			schema: z.object({
				projectId: z.string().min(1, "Pick a project"),
				...(tpl?.kind === "project"
					? {}
					: { listId: z.string().min(1, "Pick a list") }),
			}),
			render: (w) => <TargetStep w={w} needsList={tpl?.kind !== "project"} />,
		},
		{
			id: "dates",
			title: "Dates",
			description: "Template dates count working days from this anchor.",
			schema: z.object({ date: z.iso.date("Pick a date") }),
			render: (w) => (
				<div className="grid max-w-xl gap-6">
					<ChoiceGroup
						label="Anchor"
						value={w.values.mode}
						onChange={(v) => w.set("mode", v)}
						choices={[
							{
								value: "start",
								title: "Start on",
								description: "The first task starts on this date.",
								icon: CalendarArrowDown,
							},
							{
								value: "finish",
								title: "Finish by",
								description:
									"The last task is due on this date; the rest is scheduled backwards.",
								icon: CalendarArrowUp,
							},
						]}
					/>
					<Field
						id="wz-date"
						label={w.values.mode === "start" ? "Start date" : "Finish date"}
						error={w.error("date")}
					>
						<Input {...w.bind("date")} type="date" className="w-48" />
					</Field>
				</div>
			),
		},
		{
			id: "people",
			title: "People",
			description:
				"Map each role in the template to someone on the project. Unmapped roles stay unassigned.",
			when: () => placeholders.length > 0,
			render: (w) => <PeopleStep w={w} names={placeholders} />,
		},
		{
			id: "fields",
			title: "Fields",
			description: "The template sets fields this project doesn't have.",
			when: () => missing.length > 0,
			render: (w) => (
				<div className="grid max-w-xl gap-6">
					<ul className="flex flex-wrap gap-1.5">
						{missing.map((n) => (
							<li key={n}>
								<Badge variant="secondary">{n}</Badge>
							</li>
						))}
					</ul>
					<ChoiceGroup
						label="Missing fields"
						value={w.values.missingFields}
						onChange={(v) => w.set("missingFields", v)}
						choices={[
							{
								value: "create",
								title: "Create them",
								description:
									"Adds the fields to the project. Needs admin rights on Work.",
							},
							{
								value: "drop",
								title: "Skip their values",
								description: "Tasks are created without these values.",
							},
						]}
					/>
				</div>
			),
		},
		{
			id: "summary",
			title: "Summary",
			render: (w) => <SummaryStep w={w} tpl={tpl} />,
		},
	];
	const steps = raw.map((s) => ({
		...s,
		render: (w: WizardApi<Values>) => (
			<>
				<Mirror values={w.values} onValues={setValues} />
				{s.render(w)}
			</>
		),
	}));

	return (
		<WizardDialog
			open={open}
			onOpenChange={onOpenChange}
			title="New from template"
			description="Create lists and tasks from a saved template, with dates moved to your schedule."
		>
			<Wizard
				id={`work-from-template:${initialProject ?? ""}`}
				steps={steps}
				defaultValues={{
					templateId: "",
					projectId: initialProject ?? "",
					listId: initialList ?? "",
					date: today(),
					mode: "start",
					placeholders: {},
					missingFields: "drop",
				}}
				step={step}
				onStepChange={(s) => setStep(s)}
				finishLabel="Create"
				onComplete={async (v) => {
					const res = await instantiate.mutateAsync({
						id: v.templateId,
						input: inputOf(v, tpl),
					});
					toast.success(
						`Created ${res.created.tasks} task${res.created.tasks === 1 ? "" : "s"}`,
					);
					onCreated?.(res);
					onOpenChange(false);
				}}
			/>
		</WizardDialog>
	);
}

const inputOf = (v: Values, tpl: WorkTemplate | undefined) => ({
	target:
		tpl?.kind === "project" ? { projectId: v.projectId } : { listId: v.listId },
	anchor: { date: v.date, mode: v.mode },
	placeholders: Object.fromEntries(
		Object.entries(v.placeholders).filter(([, id]) => id),
	),
	missingFields: v.missingFields,
});

/** Lifts the wizard's answers to the host, whose step list (people, fields) depends on them. */
function Mirror({
	values,
	onValues,
}: {
	values: Values;
	onValues: (v: Values) => void;
}) {
	useEffect(() => onValues(values), [values, onValues]);
	return null;
}

function PickStep({
	w,
	projectId,
}: {
	w: WizardApi<Values>;
	projectId?: string;
}) {
	const [q, setQ] = useState("");
	const { data: list = [], isPending } = useWorkTemplates(projectId);
	const { data: picked } = useWorkTemplate(w.values.templateId);
	const shown = list.filter((t) =>
		`${t.name} ${t.description ?? ""}`
			.toLowerCase()
			.includes(q.trim().toLowerCase()),
	);
	return (
		<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
			<div className="grid content-start gap-2">
				<div className="relative">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Search templates"
						aria-label="Search templates"
						className="pl-8"
						autoFocus
					/>
				</div>
				<div
					role="listbox"
					aria-label="Templates"
					aria-invalid={w.error("templateId") ? true : undefined}
					className="-m-1 grid max-h-80 gap-1 overflow-y-auto p-1"
				>
					{isPending && (
						<p className="p-3 text-sm text-muted-foreground">Loading…</p>
					)}
					{!isPending && shown.length === 0 && (
						<p className="p-3 text-sm text-muted-foreground">
							No templates match.
						</p>
					)}
					{shown.map((t) => (
						<button
							key={t.id}
							type="button"
							role="option"
							aria-selected={w.values.templateId === t.id}
							onClick={() => w.set("templateId", t.id)}
							className={cn(
								"rounded-lg p-3 text-left ring-1 ring-border outline-none t-press hover:ring-foreground/25 focus-visible:ring-2 focus-visible:ring-ring",
								w.values.templateId === t.id && "ring-2 ring-foreground",
							)}
						>
							<span className="flex items-center gap-2 text-sm font-medium">
								{t.name}
								{t.builtin && (
									<span className="rounded-sm bg-muted px-1.5 py-px text-2xs text-muted-foreground">
										Built-in
									</span>
								)}
							</span>
							<span className="mt-0.5 block text-xs text-muted-foreground">
								{t.description ?? `${t.kind} template`} · {t.taskCount} tasks
							</span>
						</button>
					))}
				</div>
				{w.error("templateId") && (
					<p className="text-xs text-bad-text">{w.error("templateId")}</p>
				)}
			</div>
			<div className="max-h-96 overflow-y-auto rounded-lg bg-muted/50 p-3 dark:bg-muted/30">
				{picked ? (
					<PreviewTree payload={picked.payload} />
				) : (
					<p className="text-sm text-muted-foreground">
						Pick a template to preview its tasks.
					</p>
				)}
			</div>
		</div>
	);
}

function PreviewTree({ payload }: { payload: TemplatePayload }) {
	const tasks = (ts: readonly TaskTemplate[], depth = 0): React.ReactNode =>
		ts.map((t, i) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: template tasks have no ids
			<li key={i}>
				<span
					className="flex items-center gap-1.5 py-0.5 text-sm"
					style={{ paddingLeft: depth * 16 }}
				>
					<span
						aria-hidden
						className={cn(
							"size-1.5 shrink-0",
							t.isMilestone
								? "rotate-45 bg-foreground"
								: "rounded-full bg-muted-foreground/50",
						)}
					/>
					{t.title}
				</span>
				{t.subtasks.length > 0 && <ul>{tasks(t.subtasks, depth + 1)}</ul>}
			</li>
		));
	return (
		<div className="grid gap-3">
			{payload.statuses?.length ? (
				<p className="text-xs text-muted-foreground">
					Statuses: {payload.statuses.map((s) => s.name).join(", ")}
				</p>
			) : null}
			{(payload.lists ?? []).map((l) => (
				<section key={l.name}>
					<h3 className="mb-1 text-xs font-medium text-muted-foreground">
						{l.name}
					</h3>
					<ul>{tasks(l.tasks)}</ul>
				</section>
			))}
			{payload.tasks?.length ? <ul>{tasks(payload.tasks)}</ul> : null}
		</div>
	);
}

function TargetStep({
	w,
	needsList,
}: {
	w: WizardApi<Values>;
	needsList: boolean;
}) {
	const { data: projects = [] } = useWorkProjects();
	const { data: lists = [] } = useWorkLists(w.values.projectId);
	const open = lists.filter((l) => !l.archivedAt);
	return (
		<div className="grid max-w-xl gap-6">
			<Field id="wz-projectId" label="Project" error={w.error("projectId")}>
				<Select
					value={w.values.projectId}
					onValueChange={(v) => {
						w.set("projectId", v);
						w.set("listId", "");
					}}
				>
					<SelectTrigger
						id="wz-projectId"
						className="w-full"
						aria-invalid={!!w.error("projectId") || undefined}
					>
						<SelectValue placeholder="Choose a project" />
					</SelectTrigger>
					<SelectContent>
						{projects
							.filter((p) => !p.archived)
							.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.name}
								</SelectItem>
							))}
					</SelectContent>
				</Select>
			</Field>
			{needsList && (
				<Field id="wz-listId" label="List" error={w.error("listId")}>
					<Select
						value={w.values.listId}
						onValueChange={(v) => w.set("listId", v)}
						disabled={!w.values.projectId}
					>
						<SelectTrigger
							id="wz-listId"
							className="w-full"
							aria-invalid={!!w.error("listId") || undefined}
						>
							<SelectValue placeholder="Choose a list" />
						</SelectTrigger>
						<SelectContent>
							{open.map((l) => (
								<SelectItem key={l.id} value={l.id}>
									{l.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			)}
		</div>
	);
}

const NOBODY = "_none";

function PeopleStep({ w, names }: { w: WizardApi<Values>; names: string[] }) {
	const { data: people = [] } = useWorkPeople(w.values.projectId);
	const assignable = people.filter((p) => p.assignable);
	return (
		<div className="grid max-w-xl gap-4">
			{names.map((n) => (
				<div
					key={n}
					className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-3"
				>
					<span className="truncate text-sm font-medium">{n}</span>
					<Select
						value={w.values.placeholders[n] || NOBODY}
						onValueChange={(v) =>
							w.set("placeholders", {
								...w.values.placeholders,
								[n]: v === NOBODY ? "" : v,
							})
						}
					>
						<SelectTrigger aria-label={`Person for ${n}`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NOBODY}>Leave unassigned</SelectItem>
							{assignable.map((p) => (
								<SelectItem key={p.userId} value={p.userId}>
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			))}
		</div>
	);
}

function SummaryStep({
	w,
	tpl,
}: {
	w: WizardApi<Values>;
	tpl: WorkTemplate | undefined;
}) {
	const dry = useInstantiateWorkTemplate();
	const { mutate } = dry;
	const input = JSON.stringify(inputOf(w.values, tpl));
	useEffect(() => {
		if (tpl)
			mutate({ id: tpl.id, input: { ...JSON.parse(input), dryRun: true } });
	}, [tpl, input, mutate]);
	const r = dry.data;
	const count = (n: number, word: string) =>
		n ? `${n} ${word}${n === 1 ? "" : "s"}` : null;
	return (
		<div className="grid gap-4">
			<Summary
				w={w}
				sections={[
					{
						stepId: "pick",
						title: "Template",
						rows: [{ label: "Name", value: tpl?.name ?? "…" }],
					},
					{
						stepId: "dates",
						title: "Dates",
						rows: [
							{
								label: w.values.mode === "start" ? "Starts on" : "Finishes by",
								value: w.values.date,
							},
						],
					},
					{
						stepId: "target",
						title: "Creates",
						rows: [
							{
								label: "Items",
								value: dry.isPending ? (
									"Counting…"
								) : dry.isError ? (
									<span className="text-bad-text">{dry.error.message}</span>
								) : r ? (
									[
										count(r.created.tasks, "task"),
										count(r.created.lists, "list"),
										count(r.created.fields, "field"),
										count(r.created.statuses, "status"),
									]
										.filter(Boolean)
										.join(", ") || "Nothing"
								) : (
									"…"
								),
							},
						],
					},
				]}
			/>
			{r?.warnings.length ? (
				<ul className="grid gap-1 rounded-lg bg-warn/10 p-3 text-sm text-warn-text">
					{r.warnings.map((m) => (
						<li key={m}>{m}</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
