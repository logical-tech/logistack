/*
 * Project settings → Work: key, working days, closing status, statuses, fields, tags, lists,
 * which services count for health, linked repositories, and the sharing switches (their full
 * flows live with share links, guests and time tracking).
 */
import type {
	WorkColor,
	WorkProjectSettingsPatch,
	WorkRepo,
} from "@logistack/contracts";
import { WorkKey } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { Archive, Lock, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { gitProvidersQuery } from "@/lib/api/integrations";
import {
	useArchiveWorkList,
	useCreateWorkList,
	useCreateWorkTag,
	useDeleteWorkField,
	useDeleteWorkTag,
	useUpdateWorkField,
	useUpdateWorkList,
	useUpdateWorkSettings,
	useUpdateWorkTag,
	useWorkServices,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { WORK_COLORS } from "../lib";
import { StatusIcon } from "../parts";
import { useWorkProjectContext } from "../use-work-project";
import type { WorkProjectContext } from "../views/types";
import { FIELD_KINDS, FieldWizard } from "./field-wizard";
import { ColorPicker, StatusEditor } from "./status-editor";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fail = (what: string) => (e: unknown) =>
	toast.error(what, {
		description: e instanceof Error ? e.message : undefined,
	});

function Row({
	label,
	hint,
	children,
	htmlFor,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
	htmlFor?: string;
}) {
	return (
		<div className="grid gap-2 px-4 py-3.5 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-center sm:gap-6">
			<div>
				<label htmlFor={htmlFor} className="text-sm font-medium">
					{label}
				</label>
				{hint && (
					<p className="text-xs text-pretty text-muted-foreground">{hint}</p>
				)}
			</div>
			<div className="min-w-0">{children}</div>
		</div>
	);
}

export function WorkSettings({ projectId }: { projectId: string }) {
	const { data: project } = useWorkProjectContext(projectId);
	if (!project)
		return (
			<Page className="max-w-4xl">
				<Skeleton className="mb-6 h-8 w-64" />
				<Skeleton className="h-96" />
			</Page>
		);
	if (!project.canAdmin)
		return (
			<Page className="max-w-4xl">
				<EmptyState
					icon={Lock}
					title="Only project managers change these"
					description="Statuses, fields and other task settings need the project manager or admin role."
				/>
			</Page>
		);
	return (
		<Page className="max-w-4xl">
			<PageHeader
				title={`${project.name} task settings`}
				description="How tasks work in this project. Changes apply to everyone on it."
			/>
			<div className="grid gap-8">
				<General project={project} />
				<Panel title="Statuses" id="work-statuses">
					<StatusEditor projectId={project.id} statuses={project.statuses} />
				</Panel>
				<Fields project={project} />
				<Tags project={project} />
				<Lists project={project} />
				<Health project={project} />
				<Repos project={project} />
				<Sharing project={project} />
			</div>
		</Page>
	);
}

function useSettings(project: WorkProjectContext) {
	const update = useUpdateWorkSettings();
	return (patch: WorkProjectSettingsPatch, ok?: string) =>
		update.mutate(
			{ id: project.id, patch },
			{
				onSuccess: () => ok && toast.success(ok),
				onError: fail("The setting wasn't saved"),
			},
		);
}

function General({ project }: { project: WorkProjectContext }) {
	const save = useSettings(project);
	const s = project.settings;
	const [key, setKey] = useState(s.key);
	const keyOk = WorkKey.safeParse(key).success;
	const done = project.statuses.filter((x) => x.category === "done");
	return (
		<Panel title="General" id="work-general" bodyClassName="divide-y">
			<Row
				label="Task key"
				htmlFor="work-key"
				hint="The prefix of task IDs. Old links keep working after a change."
			>
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (keyOk && key !== s.key) save({ key }, `Tasks are now ${key}-n`);
					}}
				>
					<Input
						id="work-key"
						value={key}
						onChange={(e) =>
							setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
						}
						maxLength={10}
						aria-invalid={!keyOk || undefined}
						aria-describedby="work-key-help"
						className="w-32 font-medium tabular"
					/>
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={!keyOk || key === s.key}
					>
						Save
					</Button>
					<span
						id="work-key-help"
						className={cn(
							"text-xs",
							keyOk ? "text-muted-foreground" : "text-bad-text",
						)}
					>
						{keyOk
							? `Tasks look like ${key}-12`
							: "2–10 letters or digits, starting with a letter"}
					</span>
				</form>
			</Row>
			<Row
				label="Working days"
				hint="Used when dates shift and to count durations."
			>
				<fieldset className="flex flex-wrap gap-1" aria-label="Working days">
					{DAYS.map((d, i) => {
						const bit = 1 << i;
						const on = (s.workingDays & bit) !== 0;
						return (
							<button
								key={d}
								type="button"
								aria-pressed={on}
								onClick={() => {
									const next = s.workingDays ^ bit;
									if (next === 0) {
										toast("Keep at least one working day");
										return;
									}
									save({ workingDays: next });
								}}
								className={cn(
									"t-press h-8 w-11 rounded-md text-sm font-medium ring-1 transition-colors duration-(--duration-quick)",
									on
										? "bg-foreground text-background ring-foreground"
										: "text-muted-foreground ring-border hover:bg-muted",
								)}
							>
								{d}
							</button>
						);
					})}
				</fieldset>
			</Row>
			<Row
				label="Closing status"
				hint="Where “Fixes SHOP-12” in a commit moves the task."
			>
				<Select
					value={s.closingStatusId ?? "first"}
					onValueChange={(v) =>
						save({ closingStatusId: v === "first" ? null : v })
					}
				>
					<SelectTrigger aria-label="Closing status" className="w-56">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="first">
							First done status ({done[0]?.name})
						</SelectItem>
						{done.map((x) => (
							<SelectItem key={x.id} value={x.id}>
								<StatusIcon status={x} /> {x.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Row>
			<Row label="Default list" hint="Where quick-add and imports land.">
				<Select
					value={s.defaultListId ?? project.lists[0]?.id ?? ""}
					onValueChange={(v) => save({ defaultListId: v })}
				>
					<SelectTrigger aria-label="Default list" className="w-56">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{project.lists.map((l) => (
							<SelectItem key={l.id} value={l.id}>
								{l.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Row>
		</Panel>
	);
}

function Fields({ project }: { project: WorkProjectContext }) {
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState<string | null>(null);
	const update = useUpdateWorkField();
	const remove = useDeleteWorkField();
	const target = project.fields.find((f) => f.id === deleting);
	return (
		<Panel
			title="Fields"
			id="work-fields"
			actions={
				<Button
					size="sm"
					variant="outline"
					onClick={() => setCreating(true)}
					disabled={project.fields.length >= 100}
				>
					<Plus data-icon="inline-start" /> New field
				</Button>
			}
		>
			{project.fields.length === 0 ? (
				<p className="px-4 py-6 text-sm text-muted-foreground">
					No custom fields yet. Add one for anything your tasks need to track: a
					client, a budget, a link.
				</p>
			) : (
				<ul className="divide-y">
					{project.fields.map((f) => {
						const Kind = FIELD_KINDS[f.kind];
						return (
							<li
								key={f.id}
								className="flex flex-wrap items-center gap-3 px-4 py-2.5"
							>
								<Kind.icon
									className="size-4 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								<Input
									aria-label="Field name"
									defaultValue={f.name}
									onBlur={(e) => {
										const n = e.target.value.trim();
										if (n && n !== f.name)
											update.mutate(
												{ projectId: project.id, id: f.id, patch: { name: n } },
												{ onError: fail("The field wasn't renamed") },
											);
									}}
									className="h-8 w-48"
								/>
								<span className="text-xs text-muted-foreground">
									{Kind.label}
									{f.listId &&
										` · only ${project.lists.find((l) => l.id === f.listId)?.name ?? "one list"}`}
								</span>
								<div className="ml-auto flex items-center gap-2">
									<Switch
										id={`req-${f.id}`}
										checked={f.required}
										onCheckedChange={(required) =>
											update.mutate({
												projectId: project.id,
												id: f.id,
												patch: { required },
											})
										}
									/>
									<label
										htmlFor={`req-${f.id}`}
										className="text-xs text-muted-foreground"
									>
										Required
									</label>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={`Delete ${f.name}`}
										className="text-muted-foreground"
										onClick={() => setDeleting(f.id)}
									>
										<Trash2 />
									</Button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			<FieldWizard
				open={creating}
				onOpenChange={setCreating}
				project={project}
			/>
			<ConfirmDialog
				open={!!target}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete the field “${target?.name}”?`}
				description="Its values on every task are deleted too. To change a field's kind, create a new one instead."
				confirmLabel="Delete field"
				pending={remove.isPending}
				onConfirm={() =>
					target &&
					remove.mutate(
						{ projectId: project.id, id: target.id },
						{
							onSuccess: () => setDeleting(null),
							onError: fail("The field wasn't deleted"),
						},
					)
				}
			/>
		</Panel>
	);
}

function Tags({ project }: { project: WorkProjectContext }) {
	const create = useCreateWorkTag();
	const update = useUpdateWorkTag();
	const remove = useDeleteWorkTag();
	const [name, setName] = useState("");
	return (
		<Panel title="Tags" id="work-tags" bodyClassName="p-4">
			<ul className="flex flex-wrap gap-2">
				{project.tags.map((t) => (
					<li
						key={t.id}
						className="flex items-center gap-1 rounded-lg bg-muted/50 py-0.5 pr-0.5 pl-0.5"
					>
						<ColorPicker
							label={t.name}
							value={t.color}
							onChange={(color) =>
								update.mutate({
									projectId: project.id,
									id: t.id,
									patch: { color },
								})
							}
						/>
						<Input
							aria-label="Tag name"
							defaultValue={t.name}
							onBlur={(e) => {
								const n = e.target.value.trim();
								if (n && n !== t.name)
									update.mutate({
										projectId: project.id,
										id: t.id,
										patch: { name: n },
									});
							}}
							className="h-7 w-28 border-transparent bg-transparent px-1 shadow-none dark:bg-transparent"
						/>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={`Delete tag ${t.name}`}
							onClick={() =>
								remove.mutate(
									{ projectId: project.id, id: t.id },
									{ onError: fail("The tag wasn't deleted") },
								)
							}
						>
							<X />
						</Button>
					</li>
				))}
			</ul>
			<form
				className="mt-3 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					const n = name.trim();
					if (!n) return;
					create.mutate(
						{
							projectId: project.id,
							input: {
								name: n,
								color: WORK_COLORS[
									project.tags.length % WORK_COLORS.length
								] as WorkColor,
							},
						},
						{
							onSuccess: () => setName(""),
							onError: fail("The tag wasn't added"),
						},
					);
				}}
			>
				<Input
					aria-label="New tag"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="New tag"
					className="h-8 w-48"
				/>
				<Button
					type="submit"
					size="sm"
					variant="outline"
					disabled={!name.trim()}
				>
					Add tag
				</Button>
			</form>
		</Panel>
	);
}

function Lists({ project }: { project: WorkProjectContext }) {
	const create = useCreateWorkList();
	const update = useUpdateWorkList();
	const archive = useArchiveWorkList();
	const [name, setName] = useState("");
	return (
		<Panel title="Lists" id="work-lists-settings">
			<ul className="divide-y">
				{project.lists.map((l) => (
					<li key={l.id} className="flex items-center gap-2 px-4 py-2">
						<ColorPicker
							label={l.name}
							value={l.color ?? "gray"}
							onChange={(color) =>
								update.mutate({
									projectId: project.id,
									id: l.id,
									patch: { color },
								})
							}
						/>
						<Input
							aria-label="List name"
							defaultValue={l.name}
							onBlur={(e) => {
								const n = e.target.value.trim();
								if (n && n !== l.name)
									update.mutate({
										projectId: project.id,
										id: l.id,
										patch: { name: n },
									});
							}}
							className="h-8 w-56"
						/>
						<Button
							variant="ghost"
							size="sm"
							className="ml-auto text-muted-foreground"
							disabled={project.lists.length < 2}
							onClick={() =>
								archive.mutate(
									{ projectId: project.id, id: l.id, archived: true },
									{
										onSuccess: () => toast.success(`${l.name} archived`),
										onError: fail("The list wasn't archived"),
									},
								)
							}
						>
							<Archive data-icon="inline-start" /> Archive
						</Button>
					</li>
				))}
			</ul>
			<form
				className="flex gap-2 border-t px-4 py-3"
				onSubmit={(e) => {
					e.preventDefault();
					const n = name.trim();
					if (!n) return;
					create.mutate(
						{ projectId: project.id, input: { name: n, color: "gray" } },
						{
							onSuccess: () => setName(""),
							onError: fail("The list wasn't created"),
						},
					);
				}}
			>
				<Input
					aria-label="New list"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="New list"
					className="h-8 w-56"
				/>
				<Button
					type="submit"
					size="sm"
					variant="outline"
					disabled={!name.trim()}
				>
					Add list
				</Button>
			</form>
		</Panel>
	);
}

function Health({ project }: { project: WorkProjectContext }) {
	const { data: services } = useWorkServices(project.id);
	const save = useSettings(project);
	const hidden = project.settings.hiddenServiceIds ?? [];
	return (
		<Panel
			title="Services in health"
			id="work-health-settings"
			bodyClassName="p-4"
		>
			<p className="mb-3 text-sm text-muted-foreground">
				Unticked services are left out of the health that project managers and
				clients see.
			</p>
			{!services ? (
				<Skeleton className="h-16" />
			) : services.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					This project has no services.
				</p>
			) : (
				<ul className="grid gap-2 sm:grid-cols-2">
					{services.map((s) => (
						<li key={s.id} className="flex items-center gap-2">
							<Checkbox
								id={`svc-${s.id}`}
								checked={!hidden.includes(s.id)}
								onCheckedChange={(v) =>
									save({
										hiddenServiceIds: v
											? hidden.filter((id) => id !== s.id)
											: [...hidden, s.id],
									})
								}
							/>
							<label htmlFor={`svc-${s.id}`} className="text-sm">
								{s.name}
							</label>
						</li>
					))}
				</ul>
			)}
		</Panel>
	);
}

function Repos({ project }: { project: WorkProjectContext }) {
	const save = useSettings(project);
	const { data: providers = [] } = useQuery({
		...gitProvidersQuery,
		retry: false,
	});
	const repos = project.settings.repos ?? [];
	const [providerId, setProviderId] = useState("");
	const [repo, setRepo] = useState("");
	const valid = providerId && /^[\w.-]+\/[\w.-]+$/.test(repo.trim());
	const name = (r: WorkRepo) =>
		providers.find((p) => p.id === r.providerId)?.name ?? "Git provider";
	return (
		<Panel title="Repositories" id="work-repos" bodyClassName="p-4">
			<p className="mb-3 text-sm text-muted-foreground">
				Commits and pull requests that mention a task key link to it. The
				repositories of this project's services count already; add others here.
			</p>
			{repos.length > 0 && (
				<ul className="mb-3 grid gap-1">
					{repos.map((r) => (
						<li
							key={`${r.providerId}:${r.repo}`}
							className="flex items-center gap-2 text-sm"
						>
							<span className="text-muted-foreground">{name(r)}</span>
							<span className="font-medium">{r.repo}</span>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={`Remove ${r.repo}`}
								onClick={() => save({ repos: repos.filter((x) => x !== r) })}
							>
								<X />
							</Button>
						</li>
					))}
				</ul>
			)}
			<form
				className="flex flex-wrap gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (!valid) return;
					save(
						{ repos: [...repos, { providerId, repo: repo.trim() }] },
						"Repository linked",
					);
					setRepo("");
				}}
			>
				<Select value={providerId} onValueChange={setProviderId}>
					<SelectTrigger aria-label="Git provider" className="w-48">
						<SelectValue
							placeholder={
								providers.length ? "Git provider" : "No git providers"
							}
						/>
					</SelectTrigger>
					<SelectContent>
						{providers.map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{p.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input
					aria-label="Repository"
					value={repo}
					onChange={(e) => setRepo(e.target.value)}
					placeholder="owner/repo"
					className="h-8 w-56"
				/>
				<Button type="submit" size="sm" variant="outline" disabled={!valid}>
					Link
				</Button>
			</form>
		</Panel>
	);
}

function Sharing({ project }: { project: WorkProjectContext }) {
	const save = useSettings(project);
	const s = project.settings;
	const rows: [keyof WorkProjectSettingsPatch, string, string, boolean][] = [
		[
			"allowShareLinks",
			"Share links",
			"Read-only links to a list or a view for people without an account.",
			s.allowShareLinks,
		],
		[
			"guestsAssignable",
			"Guests can be assigned",
			"Clients invited as guests can own tasks.",
			s.guestsAssignable,
		],
		[
			"guestsCanCreate",
			"Guests can create tasks",
			"They land in the default list's backlog with a “From guest” tag.",
			s.guestsCanCreate,
		],
		[
			"timeTracking",
			"Time tracking",
			"Timers and time entries on tasks. Off hides them everywhere.",
			s.timeTracking,
		],
	];
	return (
		<Panel
			title="Sharing and access"
			id="work-sharing"
			bodyClassName="divide-y"
		>
			{rows.map(([key, label, hint, value]) => (
				<Row key={key} label={label} hint={hint} htmlFor={`work-${key}`}>
					<Switch
						id={`work-${key}`}
						checked={value}
						onCheckedChange={(v) => save({ [key]: v })}
					/>
				</Row>
			))}
		</Panel>
	);
}
