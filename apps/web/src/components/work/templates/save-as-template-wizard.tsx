import type { WorkTemplateCreate } from "@logistack/contracts";
import { Building2, FolderKanban } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { useCreateWorkTemplate } from "@/lib/api/work-queries";
import { WizardDialog } from "./template-dialog";

type Values = {
	name: string;
	description: string;
	scope: "project" | "organization";
	subtasks: boolean;
	checklist: boolean;
	fieldValues: boolean;
	assignees: WorkTemplateCreate["include"]["assignees"];
	attachments: boolean;
	descriptions: boolean;
};

const INCLUDE: { key: keyof Values; label: string; hint: string }[] = [
	{ key: "subtasks", label: "Subtasks", hint: "Each task's subtasks, nested." },
	{ key: "checklist", label: "Checklists", hint: "Items start unticked." },
	{ key: "fieldValues", label: "Field values", hint: "Custom field values." },
	{ key: "descriptions", label: "Descriptions", hint: "Task descriptions." },
	{
		key: "attachments",
		label: "Attachments",
		hint: "Files are shared, not copied.",
	},
];

const KIND_NAME = { task: "task", list: "list", project: "project setup" };

/** "Save as template": name and scope → what to include → summary. */
export function SaveAsTemplateWizard({
	source,
	projectId,
	defaultName = "",
	open,
	onOpenChange,
	onSaved,
}: {
	source: WorkTemplateCreate["source"];
	/** The project the source lives in; "this project" scope saves the template there. */
	projectId: string;
	defaultName?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved?: (templateId: string) => void;
}) {
	const [step, setStep] = useState<string>();
	const create = useCreateWorkTemplate();
	const what = KIND_NAME[source.kind];

	const steps: WizardStep<Values>[] = [
		{
			id: "name",
			title: "Name and scope",
			description: `Save this ${what} so the team can start new work from it.`,
			schema: z.object({
				name: z.string().trim().min(1, "Give it a name").max(100),
				description: z.string().max(1000),
			}),
			render: (w) => (
				<div className="grid max-w-xl gap-6">
					<Field id="wz-name" label="Name" error={w.error("name")}>
						<Input {...w.bind("name")} autoFocus autoComplete="off" />
					</Field>
					<Field id="wz-description" label="Description" optional>
						<Textarea {...w.bind("description")} rows={2} />
					</Field>
					<ChoiceGroup
						label="Who can use it"
						value={w.values.scope}
						onChange={(v) => w.set("scope", v)}
						choices={[
							{
								value: "project",
								title: "This project",
								description: "Listed only inside this project.",
								icon: FolderKanban,
							},
							{
								value: "organization",
								title: "Whole organization",
								description:
									"Every project can use it. Needs admin rights on Work.",
								icon: Building2,
							},
						]}
					/>
				</div>
			),
		},
		{
			id: "include",
			title: "What to include",
			description:
				"Titles, priorities, estimates and relative dates are always kept.",
			render: (w) => (
				<div className="grid max-w-xl gap-6">
					<div className="grid gap-3">
						{INCLUDE.map((o) => (
							<label
								key={o.key}
								htmlFor={`wz-${o.key}`}
								className="flex items-start gap-3 text-sm"
							>
								<Checkbox
									id={`wz-${o.key}`}
									checked={w.values[o.key] === true}
									onCheckedChange={(v) => w.set(o.key, v === true)}
									className="mt-0.5"
								/>
								<span>
									<span className="font-medium">{o.label}</span>
									<span className="block text-xs text-muted-foreground">
										{o.hint}
									</span>
								</span>
							</label>
						))}
					</div>
					<div className="grid gap-2">
						<p className="text-sm font-medium">Assignees</p>
						<ChoiceGroup
							label="Assignees"
							columns={1}
							value={w.values.assignees}
							onChange={(v) => w.set("assignees", v)}
							choices={[
								{
									value: "placeholders",
									title: "As placeholders",
									description:
										"Roles like “Designer” that you map to people when using the template.",
								},
								{
									value: "fixed",
									title: "The same people",
									description: "New tasks go to whoever has them now.",
								},
								{
									value: "none",
									title: "Leave unassigned",
									description: "Assign people after creating.",
								},
							]}
						/>
					</div>
				</div>
			),
		},
		{
			id: "summary",
			title: "Summary",
			render: (w) => (
				<Summary
					w={w}
					sections={[
						{
							stepId: "name",
							title: "Template",
							rows: [
								{ label: "Name", value: w.values.name },
								{
									label: "Available in",
									value:
										w.values.scope === "project"
											? "This project"
											: "Whole organization",
								},
							],
						},
						{
							stepId: "include",
							title: "Includes",
							rows: [
								{
									label: "Content",
									value:
										INCLUDE.filter((o) => w.values[o.key] === true)
											.map((o) => o.label)
											.join(", ") || "Tasks only",
								},
								{
									label: "Assignees",
									value: {
										placeholders: "As placeholders",
										fixed: "The same people",
										none: "Unassigned",
									}[w.values.assignees],
								},
							],
						},
					]}
				/>
			),
		},
	];

	return (
		<WizardDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Save as template"
			description={`Reuse this ${what} later, with its dates shifted to wherever you start.`}
		>
			<Wizard<Values>
				id={`work-save-template:${JSON.stringify(source)}`}
				steps={steps}
				defaultValues={{
					name: defaultName,
					description: "",
					scope: "project",
					subtasks: true,
					checklist: true,
					fieldValues: true,
					assignees: "placeholders",
					attachments: false,
					descriptions: true,
				}}
				step={step}
				onStepChange={(s) => setStep(s)}
				finishLabel="Save template"
				onComplete={async (v) => {
					const tpl = await create.mutateAsync({
						name: v.name.trim(),
						description: v.description.trim() || null,
						projectId: v.scope === "project" ? projectId : null,
						source,
						include: {
							subtasks: v.subtasks,
							checklist: v.checklist,
							fieldValues: v.fieldValues,
							assignees: v.assignees,
							attachments: v.attachments,
							descriptions: v.descriptions,
						},
					});
					toast.success(`Saved “${tpl.name}”`);
					onSaved?.(tpl.id);
					onOpenChange(false);
				}}
			/>
		</WizardDialog>
	);
}

/** Detail of the `work:save-as-template` window event that task, list and project menus send. */
export type SaveAsTemplateRequest = {
	source: WorkTemplateCreate["source"];
	projectId: string;
	defaultName?: string;
};

export const requestSaveAsTemplate = (detail: SaveAsTemplateRequest) =>
	window.dispatchEvent(new CustomEvent("work:save-as-template", { detail }));

/** Opens the wizard on `work:save-as-template`. Mounted once with the Work layer. */
export function SaveAsTemplateHost() {
	const [request, setRequest] = useState<SaveAsTemplateRequest | null>(null);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const on = (e: Event) => {
			const detail = (e as CustomEvent<SaveAsTemplateRequest>).detail;
			if (!detail?.source || !detail.projectId) return;
			setRequest(detail);
			setOpen(true);
		};
		window.addEventListener("work:save-as-template", on);
		return () => window.removeEventListener("work:save-as-template", on);
	}, []);
	if (!request) return null;
	return (
		<SaveAsTemplateWizard
			// A new request starts a fresh wizard.
			key={JSON.stringify(request)}
			source={request.source}
			projectId={request.projectId}
			defaultName={request.defaultName}
			open={open}
			onOpenChange={setOpen}
		/>
	);
}
