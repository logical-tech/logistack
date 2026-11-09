/* "+ View": kind → name → shared or personal → starting filter → summary (a guided wizard). */
import type { WorkView, WorkViewKind } from "@logistack/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { useCreateWorkView } from "@/lib/api/work-queries";
import { FilterBuilder, useNamer } from "./filter-builder";
import {
	completeOnly,
	countConditions,
	describeCondition,
	isGroup,
	keyDefs,
	toNode,
	type UiFilter,
} from "./filter-model";
import { VIEW_KINDS } from "./views/registry";
import type { WorkProjectContext } from "./views/types";

type Values = {
	kind: WorkViewKind;
	name: string;
	shared: "personal" | "shared";
	filter: UiFilter;
};

export function ViewWizard({
	open,
	onOpenChange,
	project,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	project: WorkProjectContext;
	onCreated: (view: WorkView) => void;
}) {
	const [step, setStep] = useState<string | undefined>();
	const create = useCreateWorkView();
	const namer = useNamer(project);
	const defs = keyDefs(project.fields);

	const steps: WizardStep<Values>[] = [
		{
			id: "kind",
			title: "Kind",
			description: "How the tasks are laid out. You can add more views later.",
			schema: z.object({
				kind: z.enum(["table", "board", "timeline", "calendar"]),
			}),
			render: (w) => (
				<ChoiceGroup
					label="View kind"
					value={w.values.kind}
					onChange={(kind) => {
						w.set("kind", kind);
						if (
							!w.values.name ||
							Object.values(VIEW_KINDS).some((k) => k.label === w.values.name)
						)
							w.set("name", VIEW_KINDS[kind].label);
					}}
					choices={(Object.keys(VIEW_KINDS) as WorkViewKind[]).map((k) => ({
						value: k,
						title: VIEW_KINDS[k].label,
						description: VIEW_KINDS[k].description,
						icon: VIEW_KINDS[k].icon,
					}))}
				/>
			),
		},
		{
			id: "name",
			title: "Name",
			description: "Shown on the tab.",
			schema: z.object({
				name: z
					.string()
					.trim()
					.min(1, "Give the view a name")
					.max(100, "100 characters at most"),
			}),
			render: (w) => (
				<div className="grid max-w-sm gap-1.5">
					<Label htmlFor={w.bind("name").id}>View name</Label>
					<Input {...w.bind("name")} autoFocus placeholder="Due this week" />
					{w.error("name") && (
						<p className="text-xs text-bad-text">{w.error("name")}</p>
					)}
				</div>
			),
		},
		{
			id: "sharing",
			title: "Who sees it",
			schema: z.object({
				shared: z
					.enum(["personal", "shared"])
					.refine((v) => v === "personal" || project.canAdmin, {
						message: "Only project managers and admins can share views",
					}),
			}),
			render: (w) => (
				<div className="grid gap-2">
					<ChoiceGroup
						label="Visibility"
						value={w.values.shared}
						onChange={(v) => w.set("shared", v)}
						choices={[
							{
								value: "personal",
								title: "Only me",
								description: "A personal view in your tabs.",
							},
							{
								value: "shared",
								title: "Everyone on the project",
								description: project.canAdmin
									? "Appears for everyone who can see these tasks."
									: "Needs the project manager or admin role.",
							},
						]}
					/>
					{w.error("shared") && (
						<p className="text-xs text-bad-text">{w.error("shared")}</p>
					)}
				</div>
			),
		},
		{
			id: "filter",
			title: "Starting filter",
			description:
				"Optional. Narrow the tasks this view shows; you can change it any time.",
			render: (w) => (
				<div className="rounded-lg bg-card p-3 ring-1 ring-border">
					<FilterBuilder
						value={w.values.filter}
						onChange={(f) => w.set("filter", f)}
						ctx={project}
					/>
				</div>
			),
		},
		{
			id: "summary",
			title: "Summary",
			render: (w) => {
				const f = completeOnly(w.values.filter);
				return (
					<Summary
						w={w}
						sections={[
							{
								stepId: "kind",
								title: "View",
								rows: [
									{ label: "Kind", value: VIEW_KINDS[w.values.kind].label },
									{ label: "Name", value: w.values.name },
									{
										label: "Visibility",
										value:
											w.values.shared === "shared"
												? "Everyone on the project"
												: "Only me",
									},
								],
							},
							{
								stepId: "filter",
								title: "Filter",
								rows: [
									{
										label: "Conditions",
										value: countConditions(f)
											? f.items
													.flatMap((i) => (isGroup(i) ? i.conditions : [i]))
													.map((c) =>
														describeCondition(
															c,
															defs.find((d) => d.key === c.key),
															namer,
														),
													)
													.join("; ")
											: "None: every task",
									},
								],
							},
						]}
					/>
				);
			},
		},
	];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>New view</DialogTitle>
					<DialogDescription>
						A saved way of looking at {project.name}’s tasks.
					</DialogDescription>
				</DialogHeader>
				{open && (
					<Wizard
						id={`work-view:${project.id}`}
						steps={steps}
						defaultValues={{
							kind: "table",
							name: "Table",
							shared: "personal",
							filter: { mode: "and", items: [] },
						}}
						step={step}
						onStepChange={(s) => setStep(s)}
						finishLabel="Create view"
						onComplete={async (v) => {
							try {
								const view = await create.mutateAsync({
									projectId: project.id,
									input: {
										name: v.name.trim(),
										kind: v.kind,
										shared: v.shared === "shared",
										config: { filter: toNode(completeOnly(v.filter)) },
									},
								});
								setStep(undefined);
								onOpenChange(false);
								onCreated(view);
							} catch (e) {
								toast.error("The view wasn't created", {
									description: e instanceof Error ? e.message : undefined,
								});
								throw e;
							}
						}}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
