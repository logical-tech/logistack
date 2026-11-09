/*
 * New custom field: kind (with an example of how it looks) → name and description → options or
 * config → scope → required → summary. The kind can't change afterwards, so it comes first.
 */
import type {
	WorkColor,
	WorkField,
	WorkFieldConfig,
	WorkFieldKind,
	WorkSelectOption,
} from "@logistack/contracts";
import {
	AtSign,
	Calendar,
	CheckSquare,
	CircleDollarSign,
	Hash,
	Link,
	List,
	ListChecks,
	type LucideIcon,
	Percent,
	Phone,
	Star,
	Text,
	TextQuote,
	UserRound,
	X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { useCreateWorkField } from "@/lib/api/work-queries";
import { FieldDisplay } from "../field-editor";
import { WORK_COLORS } from "../lib";
import type { WorkProjectContext } from "../views/types";
import { ColorPicker } from "./status-editor";

export const FIELD_KINDS: Record<
	WorkFieldKind,
	{ label: string; icon: LucideIcon; example: unknown; description: string }
> = {
	text: {
		label: "Text",
		icon: Text,
		example: "Order #4521",
		description: "A short line of text.",
	},
	long_text: {
		label: "Long text",
		icon: TextQuote,
		example: "Notes from the kickoff call…",
		description: "Paragraphs of plain text.",
	},
	number: {
		label: "Number",
		icon: Hash,
		example: 12,
		description: "A number, with a unit if you like.",
	},
	currency: {
		label: "Money",
		icon: CircleDollarSign,
		example: "4800.00",
		description: "An amount in one currency.",
	},
	percent: {
		label: "Percent",
		icon: Percent,
		example: 60,
		description: "0 to 100%.",
	},
	date: {
		label: "Date",
		icon: Calendar,
		example: "2026-12-03",
		description: "A day, optionally with a time.",
	},
	checkbox: {
		label: "Checkbox",
		icon: CheckSquare,
		example: true,
		description: "Yes or no.",
	},
	select: {
		label: "Single choice",
		icon: List,
		example: "a",
		description: "One option from a list.",
	},
	multi_select: {
		label: "Multiple choice",
		icon: ListChecks,
		example: ["a", "b"],
		description: "Any options from a list.",
	},
	user: {
		label: "Person",
		icon: UserRound,
		example: null,
		description: "Someone on the project.",
	},
	url: {
		label: "Link",
		icon: Link,
		example: "https://acme.studio",
		description: "A web address.",
	},
	email: {
		label: "Email",
		icon: AtSign,
		example: "ana@acme.studio",
		description: "An email address.",
	},
	phone: {
		label: "Phone",
		icon: Phone,
		example: "+39 02 1234 5678",
		description: "A phone number.",
	},
	rating: {
		label: "Rating",
		icon: Star,
		example: 4,
		description: "1 to 5 stars (or flames, or hearts).",
	},
};

type Values = {
	kind: WorkFieldKind;
	name: string;
	description: string;
	options: WorkSelectOption[];
	decimals: string;
	unit: string;
	currency: string;
	withTime: boolean;
	multiple: boolean;
	ratingMax: string;
	ratingIcon: "star" | "flame" | "heart";
	maxLength: string;
	scope: string;
	required: boolean;
};

const optionId = () => `opt_${Math.random().toString(36).slice(2, 8)}`;

export function configOf(v: Values): WorkFieldConfig {
	switch (v.kind) {
		case "text":
			return {
				kind: "text",
				...(v.maxLength ? { maxLength: Number(v.maxLength) } : {}),
			};
		case "number":
			return {
				kind: "number",
				decimals: Number(v.decimals || 0),
				...(v.unit ? { unit: v.unit } : {}),
			};
		case "currency":
			return {
				kind: "currency",
				currency: v.currency.toUpperCase(),
				decimals: Number(v.decimals || 2),
			};
		case "percent":
			return { kind: "percent", decimals: Number(v.decimals || 0) };
		case "date":
			return { kind: "date", withTime: v.withTime };
		case "select":
		case "multi_select":
			return { kind: v.kind, options: v.options };
		case "user":
			return { kind: "user", multiple: v.multiple };
		case "rating":
			return {
				kind: "rating",
				max: Number(v.ratingMax || 5),
				icon: v.ratingIcon,
			};
		default:
			return { kind: v.kind } as WorkFieldConfig;
	}
}

const preview = (v: Values, project: WorkProjectContext): WorkField => ({
	id: "preview",
	projectId: project.id,
	listId: null,
	name: v.name || FIELD_KINDS[v.kind].label,
	kind: v.kind,
	config:
		v.kind === "select" || v.kind === "multi_select"
			? {
					kind: v.kind,
					options: v.options.length
						? v.options
						: [
								{ id: "a", label: "Retail", color: "blue" },
								{ id: "b", label: "Wholesale", color: "teal" },
							],
				}
			: configOf(v),
	required: false,
	description: null,
	position: "a",
});

function OptionsEditor({
	options,
	onChange,
}: {
	options: WorkSelectOption[];
	onChange: (o: WorkSelectOption[]) => void;
}) {
	const [label, setLabel] = useState("");
	const add = () => {
		const l = label.trim();
		if (!l || options.some((o) => o.label.toLowerCase() === l.toLowerCase()))
			return;
		onChange([
			...options,
			{
				id: optionId(),
				label: l,
				color: WORK_COLORS[options.length % WORK_COLORS.length] as WorkColor,
			},
		]);
		setLabel("");
	};
	return (
		<div className="grid gap-2">
			<ul className="grid gap-1">
				{options.map((o, i) => (
					<li key={o.id} className="flex items-center gap-2">
						<ColorPicker
							label={o.label}
							value={o.color}
							onChange={(color) =>
								onChange(
									options.map((x) => (x.id === o.id ? { ...x, color } : x)),
								)
							}
						/>
						<Input
							aria-label={`Option ${i + 1}`}
							value={o.label}
							onChange={(e) =>
								onChange(
									options.map((x) =>
										x.id === o.id ? { ...x, label: e.target.value } : x,
									),
								)
							}
							className="h-8"
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={`Remove ${o.label}`}
							onClick={() => onChange(options.filter((x) => x.id !== o.id))}
						>
							<X />
						</Button>
					</li>
				))}
			</ul>
			<div className="flex gap-2">
				<Input
					aria-label="New option"
					value={label}
					placeholder="Add an option, then Enter"
					onChange={(e) => setLabel(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							e.stopPropagation();
							add();
						}
					}}
					className="h-8"
				/>
				<Button type="button" variant="outline" size="sm" onClick={add}>
					Add
				</Button>
			</div>
		</div>
	);
}

function Labeled({
	id,
	label,
	children,
}: {
	id: string;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="grid max-w-sm gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children}
		</div>
	);
}

export function FieldWizard({
	open,
	onOpenChange,
	project,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	project: WorkProjectContext;
}) {
	const [step, setStep] = useState<string | undefined>();
	const create = useCreateWorkField();
	const steps: WizardStep<Values>[] = [
		{
			id: "kind",
			title: "Kind",
			description: "What the field holds. It can't change later.",
			render: (w) => (
				<div className="grid gap-4">
					<ChoiceGroup
						label="Field kind"
						columns={2}
						value={w.values.kind}
						onChange={(k) => w.set("kind", k)}
						choices={(Object.keys(FIELD_KINDS) as WorkFieldKind[]).map((k) => ({
							value: k,
							title: FIELD_KINDS[k].label,
							description: FIELD_KINDS[k].description,
							icon: FIELD_KINDS[k].icon,
						}))}
					/>
					<div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
						<span className="text-muted-foreground">Looks like</span>
						<FieldDisplay
							field={preview(w.values, project)}
							value={
								FIELD_KINDS[w.values.kind].example ?? project.people[0]?.userId
							}
							people={project.people}
						/>
					</div>
				</div>
			),
		},
		{
			id: "name",
			title: "Name",
			schema: z.object({
				name: z
					.string()
					.trim()
					.min(1, "Give the field a name")
					.max(100)
					.refine(
						(n) =>
							!project.fields.some(
								(f) => f.name.toLowerCase() === n.trim().toLowerCase(),
							),
						"A field with this name exists",
					),
			}),
			render: (w) => (
				<div className="grid gap-4">
					<Labeled id={w.bind("name").id} label="Name">
						<Input {...w.bind("name")} autoFocus placeholder="Client type" />
						{w.error("name") && (
							<p className="text-xs text-bad-text">{w.error("name")}</p>
						)}
					</Labeled>
					<Labeled id={w.bind("description").id} label="Description (optional)">
						<Textarea
							{...w.bind("description")}
							rows={2}
							placeholder="Shown as a tooltip next to the field."
						/>
					</Labeled>
				</div>
			),
		},
		{
			id: "config",
			title: "Options",
			schema: (v: Values) =>
				v.kind === "select" || v.kind === "multi_select"
					? z.object({
							options: z.array(z.unknown()).min(1, "Add at least one option"),
						})
					: v.kind === "currency"
						? z.object({
								currency: z
									.string()
									.regex(/^[A-Za-z]{3}$/, "A three-letter code, like EUR"),
							})
						: z.object({}),
			render: (w) => {
				const v = w.values;
				if (v.kind === "select" || v.kind === "multi_select")
					return (
						<div className="grid gap-2">
							<OptionsEditor
								options={v.options}
								onChange={(o) => w.set("options", o)}
							/>
							{w.error("options") && (
								<p className="text-xs text-bad-text">{w.error("options")}</p>
							)}
						</div>
					);
				if (
					v.kind === "number" ||
					v.kind === "percent" ||
					v.kind === "currency"
				)
					return (
						<div className="grid gap-4">
							{v.kind === "currency" && (
								<Labeled id={w.bind("currency").id} label="Currency">
									<Input
										{...w.bind("currency")}
										className="w-28 uppercase"
										maxLength={3}
									/>
									{w.error("currency") && (
										<p className="text-xs text-bad-text">
											{w.error("currency")}
										</p>
									)}
								</Labeled>
							)}
							<Labeled id={w.bind("decimals").id} label="Decimal places">
								<Input
									{...w.bind("decimals")}
									type="number"
									min={0}
									max={6}
									className="w-28"
								/>
							</Labeled>
							{v.kind === "number" && (
								<Labeled id={w.bind("unit").id} label="Unit (optional)">
									<Input
										{...w.bind("unit")}
										placeholder="kg, pages, hours"
										className="w-40"
									/>
								</Labeled>
							)}
						</div>
					);
				if (v.kind === "date" || v.kind === "user")
					return (
						<div className="flex items-center gap-3">
							<Switch
								id="field-flag"
								checked={v.kind === "date" ? v.withTime : v.multiple}
								onCheckedChange={(c) =>
									w.set(v.kind === "date" ? "withTime" : "multiple", c)
								}
							/>
							<Label htmlFor="field-flag">
								{v.kind === "date"
									? "Include a time of day"
									: "Allow several people"}
							</Label>
						</div>
					);
				if (v.kind === "rating")
					return (
						<div className="flex flex-wrap gap-4">
							<Labeled id={w.bind("ratingMax").id} label="Maximum">
								<Input
									{...w.bind("ratingMax")}
									type="number"
									min={3}
									max={10}
									className="w-24"
								/>
							</Labeled>
							<div className="grid gap-1.5">
								<Label>Icon</Label>
								<Select
									value={v.ratingIcon}
									onValueChange={(i) =>
										w.set("ratingIcon", i as Values["ratingIcon"])
									}
								>
									<SelectTrigger aria-label="Icon" className="w-32">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="star">Stars</SelectItem>
										<SelectItem value="flame">Flames</SelectItem>
										<SelectItem value="heart">Hearts</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
					);
				if (v.kind === "text")
					return (
						<Labeled
							id={w.bind("maxLength").id}
							label="Maximum length (optional)"
						>
							<Input
								{...w.bind("maxLength")}
								type="number"
								min={1}
								max={2000}
								className="w-28"
							/>
						</Labeled>
					);
				return (
					<p className="text-sm text-muted-foreground">
						Nothing to set up for this kind.
					</p>
				);
			},
		},
		{
			id: "scope",
			title: "Where",
			render: (w) => (
				<ChoiceGroup
					label="Scope"
					columns={1}
					value={w.values.scope}
					onChange={(s) => w.set("scope", s)}
					choices={[
						{
							value: "project",
							title: "Every list",
							description: `All tasks in ${project.name}.`,
						},
						...project.lists.map((l) => ({
							value: l.id,
							title: `Only ${l.name}`,
							description: "Tasks in other lists don't show it.",
						})),
					]}
				/>
			),
		},
		{
			id: "required",
			title: "Required",
			render: (w) => (
				<div className="flex items-start gap-3">
					<Switch
						id="field-required"
						checked={w.values.required}
						onCheckedChange={(c) => w.set("required", c)}
					/>
					<div className="grid gap-0.5">
						<Label htmlFor="field-required">Required</Label>
						<p className="text-sm text-muted-foreground">
							New tasks need it, and a task can't move to a done status while
							it's empty.
						</p>
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
							stepId: "kind",
							title: "Field",
							rows: [
								{ label: "Kind", value: FIELD_KINDS[w.values.kind].label },
								{ label: "Name", value: w.values.name },
								...(w.values.description
									? [{ label: "Description", value: w.values.description }]
									: []),
							],
						},
						{
							stepId: "config",
							title: "Setup",
							rows: [
								{
									label: "Looks like",
									value: (
										<FieldDisplay
											field={preview(w.values, project)}
											value={
												w.values.kind === "select"
													? w.values.options[0]?.id
													: w.values.kind === "multi_select"
														? w.values.options.slice(0, 2).map((o) => o.id)
														: (FIELD_KINDS[w.values.kind].example ??
															project.people[0]?.userId)
											}
											people={project.people}
										/>
									),
								},
								{
									label: "Where",
									value:
										w.values.scope === "project"
											? "Every list"
											: `Only ${project.lists.find((l) => l.id === w.values.scope)?.name}`,
								},
								{ label: "Required", value: w.values.required ? "Yes" : "No" },
							],
						},
					]}
				/>
			),
		},
	];
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>New field</DialogTitle>
					<DialogDescription>
						Extra information every task in {project.name} can carry.
					</DialogDescription>
				</DialogHeader>
				{open && (
					<Wizard
						id={`work-field:${project.id}`}
						steps={steps}
						step={step}
						onStepChange={(s) => setStep(s)}
						defaultValues={{
							kind: "select",
							name: "",
							description: "",
							options: [],
							decimals: "",
							unit: "",
							currency: "EUR",
							withTime: false,
							multiple: false,
							ratingMax: "5",
							ratingIcon: "star",
							maxLength: "",
							scope: "project",
							required: false,
						}}
						finishLabel="Create field"
						onComplete={async (v) => {
							try {
								await create.mutateAsync({
									projectId: project.id,
									input: {
										name: v.name.trim(),
										description: v.description.trim() || null,
										config: configOf(v),
										listId: v.scope === "project" ? null : v.scope,
										required: v.required,
									},
								});
								toast.success(`Field “${v.name.trim()}” created`);
								setStep(undefined);
								onOpenChange(false);
							} catch (e) {
								toast.error("The field wasn't created", {
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
