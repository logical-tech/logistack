import type { WorkShareCreated } from "@logistack/contracts";
import { Link2, Lock } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { CopyField } from "@/components/copy-button";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import {
	useCreateWorkShare,
	useWorkFields,
	useWorkLists,
	useWorkViews,
} from "@/lib/api/work-queries";

type Answers = {
	name: string;
	/** `list:<id>` or `view:<id>`. */
	target: string;
	fieldIds: string[];
	showAssignees: boolean;
	showComments: boolean;
	protect: "open" | "password";
	password: string;
	expires: "never" | "7" | "30" | "90";
};

const EXPIRY: Record<Answers["expires"], string> = {
	never: "Never",
	"7": "In 7 days",
	"30": "In 30 days",
	"90": "In 90 days",
};

/**
 * List ⋯ → "Share link…" (plan 12.7): what to show → protection → summary → copy link.
 * The token is shown once, in the last screen.
 */
export function ShareLinkDialog({
	projectId,
	listId,
	open,
	onOpenChange,
}: {
	projectId: string;
	/** Preselects a list when opened from its menu. */
	listId?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [created, setCreated] = useState<WorkShareCreated | null>(null);
	const close = (o: boolean) => {
		onOpenChange(o);
		if (!o) setCreated(null);
	};
	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{created ? "Link ready" : "Share link"}</DialogTitle>
					<DialogDescription>
						{created
							? "Copy it now: it isn't shown again. Anyone with it can read what you picked."
							: "A read-only page for someone without an account, like a client."}
					</DialogDescription>
				</DialogHeader>
				{created ? (
					<div className="t-reveal grid gap-4">
						<CopyField value={created.url} label="Copy link" />
						<p className="text-sm text-muted-foreground">
							Revoke it any time in the project's task settings, under Share
							links.
						</p>
						<div className="flex justify-end">
							<Button onClick={() => close(false)}>Done</Button>
						</div>
					</div>
				) : (
					open && (
						<ShareWizard
							projectId={projectId}
							listId={listId}
							onCreated={setCreated}
						/>
					)
				)}
			</DialogContent>
		</Dialog>
	);
}

function ShareWizard({
	projectId,
	listId,
	onCreated,
}: {
	projectId: string;
	listId?: string;
	onCreated: (c: WorkShareCreated) => void;
}) {
	const [step, setStep] = useState<string>();
	const lists = useWorkLists(projectId).data ?? [];
	const views = (useWorkViews(projectId).data ?? []).filter(
		(v) => v.ownerId === null,
	);
	const fields = useWorkFields(projectId).data ?? [];
	const create = useCreateWorkShare();
	const targetName = (t: string) => {
		const [kind, id] = t.split(":");
		return kind === "list"
			? (lists.find((l) => l.id === id)?.name ?? "List")
			: (views.find((v) => v.id === id)?.name ?? "View");
	};

	const steps: WizardStep<Answers>[] = [
		{
			id: "content",
			title: "What to show",
			description: "One list or one shared view, with the details you choose.",
			schema: z.object({
				name: z
					.string()
					.trim()
					.min(1, "Name the link so you can find it later")
					.max(100),
				target: z.string().min(1, "Pick a list or a view"),
			}),
			render: (w) => (
				<div className="grid gap-5">
					<Field
						id="share-name"
						label="Name"
						hint="Only your team sees it, in the list of links."
						error={w.error("name")}
					>
						<Input
							{...w.bind("name")}
							placeholder="Client weekly update"
							autoFocus
						/>
					</Field>
					<Field id="share-target" label="Shows" error={w.error("target")}>
						<Select
							value={w.values.target}
							onValueChange={(v) => w.set("target", v)}
						>
							<SelectTrigger id="share-target" className="w-full">
								<SelectValue placeholder="Pick a list or a view" />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectLabel>Lists</SelectLabel>
									{lists
										.filter((l) => !l.archivedAt)
										.map((l) => (
											<SelectItem key={l.id} value={`list:${l.id}`}>
												{l.name}
											</SelectItem>
										))}
								</SelectGroup>
								{views.length > 0 && (
									<SelectGroup>
										<SelectLabel>Shared views</SelectLabel>
										{views.map((v) => (
											<SelectItem key={v.id} value={`view:${v.id}`}>
												{v.name}
											</SelectItem>
										))}
									</SelectGroup>
								)}
							</SelectContent>
						</Select>
					</Field>
					<div className="grid gap-3 rounded-lg bg-muted/60 p-4 dark:bg-muted/40">
						<Toggle
							id="share-assignees"
							label="Assignees"
							hint="Names of the people on each task."
							checked={w.values.showAssignees}
							onChange={(v) => w.set("showAssignees", v)}
						/>
						<Toggle
							id="share-comments"
							label="Comments"
							hint="The discussion on each task, read-only."
							checked={w.values.showComments}
							onChange={(v) => w.set("showComments", v)}
						/>
					</div>
					{fields.length > 0 && (
						<fieldset className="grid gap-2">
							<legend className="mb-1 text-sm font-medium">
								Custom fields
							</legend>
							<p className="-mt-1 mb-1 text-sm text-muted-foreground">
								Nothing else leaves LogiStack.
							</p>
							<div className="grid gap-1.5 sm:grid-cols-2">
								{fields.map((f) => {
									const id = `share-field-${f.id}`;
									const checked = w.values.fieldIds.includes(f.id);
									return (
										<label
											key={f.id}
											htmlFor={id}
											className="flex items-center gap-2 text-sm"
										>
											<Checkbox
												id={id}
												checked={checked}
												onCheckedChange={(c) =>
													w.set(
														"fieldIds",
														c
															? [...w.values.fieldIds, f.id]
															: w.values.fieldIds.filter((x) => x !== f.id),
													)
												}
											/>
											{f.name}
										</label>
									);
								})}
							</div>
						</fieldset>
					)}
				</div>
			),
		},
		{
			id: "protect",
			title: "Protection",
			description: "Who can open it, and for how long.",
			schema: (v) =>
				v.protect === "password"
					? z.object({ password: z.string().min(6, "At least 6 characters") })
					: z.object({}),
			render: (w) => (
				<div className="grid gap-5">
					<ChoiceGroup
						label="Access"
						columns={1}
						value={w.values.protect}
						onChange={(v) => w.set("protect", v)}
						choices={[
							{
								value: "open",
								title: "Anyone with the link",
								description: "Good for a client portal you send by email.",
								icon: Link2,
							},
							{
								value: "password",
								title: "Password",
								description: "They type it once; it's remembered for 12 hours.",
								icon: Lock,
							},
						]}
					/>
					{w.values.protect === "password" && (
						<Field
							id="share-password"
							label="Password"
							error={w.error("password")}
							className="t-reveal"
						>
							<Input
								{...w.bind("password")}
								type="text"
								autoComplete="off"
								spellCheck={false}
							/>
						</Field>
					)}
					<Field id="share-expires" label="Expires">
						<Select
							value={w.values.expires}
							onValueChange={(v) => w.set("expires", v as Answers["expires"])}
						>
							<SelectTrigger id="share-expires" className="w-full sm:w-60">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(EXPIRY).map(([k, label]) => (
									<SelectItem key={k} value={k}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
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
							stepId: "content",
							title: "What to show",
							rows: [
								{ label: "Name", value: w.values.name },
								{ label: "Shows", value: targetName(w.values.target) },
								{
									label: "Also shows",
									value:
										[
											w.values.showAssignees && "assignees",
											w.values.showComments && "comments",
											...fields
												.filter((f) => w.values.fieldIds.includes(f.id))
												.map((f) => f.name),
										]
											.filter(Boolean)
											.join(", ") || "Titles, statuses and dates only",
								},
							],
						},
						{
							stepId: "protect",
							title: "Protection",
							rows: [
								{
									label: "Access",
									value:
										w.values.protect === "password"
											? "Password"
											: "Anyone with the link",
								},
								{ label: "Expires", value: EXPIRY[w.values.expires] },
							],
						},
					]}
				/>
			),
		},
	];

	return (
		<Wizard
			id={`work-share:${projectId}`}
			steps={steps}
			defaultValues={{
				name: "",
				target: listId ? `list:${listId}` : "",
				fieldIds: [],
				showAssignees: true,
				showComments: false,
				protect: "open",
				password: "",
				expires: "never",
			}}
			secretKeys={["password"]}
			step={step}
			onStepChange={(id) => setStep(id)}
			finishLabel="Create link"
			onComplete={async (v) => {
				const [kind, id] = v.target.split(":");
				const res = await create.mutateAsync({
					projectId,
					input: {
						name: v.name.trim(),
						...(kind === "list" ? { listId: id } : { viewId: id }),
						fieldIds: v.fieldIds,
						showAssignees: v.showAssignees,
						showComments: v.showComments,
						...(v.protect === "password" && { password: v.password }),
						...(v.expires !== "never" && {
							expiresAt: new Date(
								Date.now() + Number(v.expires) * 86_400_000,
							).toISOString(),
						}),
					},
				});
				onCreated(res);
			}}
		/>
	);
}

function Toggle({
	id,
	label,
	hint,
	checked,
	onChange,
}: {
	id: string;
	label: string;
	hint: string;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<div className="flex items-start justify-between gap-4">
			<label htmlFor={id} className="grid gap-0.5">
				<span className="text-sm font-medium">{label}</span>
				<span className="text-sm text-muted-foreground">{hint}</span>
			</label>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</div>
	);
}
