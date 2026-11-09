import type {
	ClickUpImportConfig,
	ClickUpInspection,
	ClickUpTreeNode,
	WorkImportPlan,
	WorkStatusCategory,
} from "@logistack/contracts";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderPlus, FolderSymlink } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Field } from "@/components/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
	ChoiceGroup,
	Instructions,
	Summary,
	TestPanel,
} from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { api } from "@/lib/api";
import { useWorkProjects } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { entityLabel, ImportPlan } from "./import-progress";

type Target = { mode: "new" | "existing"; name: string; projectId: string };
type Options = ClickUpImportConfig["options"];
type V = {
	token: string;
	teamId: string;
	listIds: string[];
	targets: Record<string, Target>;
	statuses: Record<string, WorkStatusCategory>;
	fields: Record<string, "import" | "skip" | "text_snapshot">;
	people: Record<string, string>;
	options: Options;
};

type Group = {
	id: string;
	type: "space" | "folder";
	name: string;
	lists: ClickUpTreeNode[];
};

/** Lists grouped by where they live: a folder, or a space for folderless lists. Each group becomes one project. */
function groupsOf(tree: ClickUpTreeNode[]): Group[] {
	return tree.flatMap((space) => {
		const direct = space.children.filter((c) => c.type === "list");
		const folders = space.children.filter((c) => c.type === "folder");
		return [
			...(direct.length
				? [
						{
							id: space.id,
							type: "space" as const,
							name: space.name,
							lists: direct,
						},
					]
				: []),
			...folders.map((f) => ({
				id: f.id,
				type: "folder" as const,
				name: f.name,
				lists: f.children,
			})),
		];
	});
}

const treeQuery = (token: string, teamId: string) =>
	queryOptions({
		queryKey: ["clickup", "tree", teamId, token.slice(-6)],
		queryFn: () => api.work.imports.clickupTree({ token, teamId }),
		enabled: !!token && !!teamId,
		staleTime: 5 * 60_000,
	});
const inspectQuery = (token: string, teamId: string, listIds: string[]) =>
	queryOptions({
		queryKey: [
			"clickup",
			"inspect",
			teamId,
			token.slice(-6),
			[...listIds].sort().join(","),
		],
		queryFn: () => api.work.imports.clickupInspect({ token, teamId, listIds }),
		enabled: !!token && !!teamId && listIds.length > 0,
		staleTime: 5 * 60_000,
	});

const CATEGORY: Record<WorkStatusCategory, string> = {
	backlog: "Backlog",
	active: "Active",
	done: "Done",
	cancelled: "Cancelled",
};

const OPTIONS: { key: keyof Options; label: string; hint: string }[] = [
	{
		key: "closedTasks",
		label: "Closed tasks",
		hint: "Done and closed tasks come along, in a done status.",
	},
	{
		key: "comments",
		label: "Comments",
		hint: "Threads with replies; mentions of matched people stay mentions.",
	},
	{
		key: "attachments",
		label: "Attachments",
		hint: "Files up to 25 MB each count against attachment storage.",
	},
	{
		key: "timeEntries",
		label: "Time entries",
		hint: "Only for matched people, and only where time tracking is on.",
	},
	{
		key: "archivedLists",
		label: "Archived lists",
		hint: "Lists archived in ClickUp; off keeps them behind.",
	},
	{
		key: "keepUrls",
		label: "Keep ClickUp links",
		hint: "Each task remembers its ClickUp URL.",
	},
];

/** ClickUp → Work in eight steps (plan 12.5): connect, choose, statuses, fields, people, options, dry run, import. */
export function ClickUpWizard({
	step,
	onStepChange,
}: {
	step: string | undefined;
	onStepChange: (id: string, opts: { replace: boolean }) => void;
}) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
	const [dry, setDry] = useState<{
		importId: string;
		plan: WorkImportPlan;
	} | null>(null);

	const configOf = (v: V): ClickUpImportConfig => {
		const tree = qc.getQueryData(treeQuery(v.token, v.teamId).queryKey) ?? [];
		const inspection = qc.getQueryData(
			inspectQuery(v.token, v.teamId, v.listIds).queryKey,
		);
		return {
			token: v.token,
			teamId: v.teamId,
			targets: groupsOf(tree).flatMap((g) => {
				const listIds = g.lists
					.filter((l) => v.listIds.includes(l.id))
					.map((l) => l.id);
				if (!listIds.length) return [];
				const t = v.targets[g.id] ?? {
					mode: "new",
					name: g.name,
					projectId: "",
				};
				return [
					{
						sourceId: g.id,
						sourceType: g.type,
						listIds,
						target:
							t.mode === "existing"
								? { kind: "existing" as const, projectId: t.projectId }
								: {
										kind: "new" as const,
										name: t.name.trim() || g.name,
										folderId: null,
									},
					},
				];
			}),
			statuses: Object.fromEntries(
				(inspection?.statuses ?? []).map((s) => [
					s.key,
					{
						create: {
							...s.proposed,
							category: v.statuses[s.key] ?? s.proposed.category,
						},
					},
				]),
			),
			fields: Object.fromEntries(
				(inspection?.fields ?? []).map((f) => {
					const mode = v.fields[f.id] ?? (f.proposed ? "import" : "skip");
					return [
						f.id,
						mode === "import" && f.proposed
							? { mode: "import" as const, config: f.proposed }
							: mode === "text_snapshot"
								? { mode: "text_snapshot" as const }
								: { mode: "skip" as const },
					];
				}),
			),
			people: Object.fromEntries(
				(inspection?.members ?? []).map((m) => [
					m.id,
					v.people[m.id] ?? m.matchUserId ?? "unassigned",
				]),
			) as ClickUpImportConfig["people"],
			options: v.options,
		};
	};

	const steps: WizardStep<V>[] = [
		{
			id: "connect",
			title: "Connect",
			description:
				"A personal API token reads your workspace. It's stored encrypted and wiped when the import ends.",
			schema: z.object({
				token: z.string().trim().min(10, "Paste the token from ClickUp"),
			}),
			testKeys: ["token"],
			test: async (v) => {
				try {
					const c = await api.work.imports.clickupTest({
						token: v.token.trim(),
					});
					setTeams(c.teams);
					return {
						ok: true,
						message: `Connected as ${c.user.username}`,
						detail: `${c.teams.length} ${c.teams.length === 1 ? "workspace" : "workspaces"}: ${c.teams.map((t) => t.name).join(", ")}`,
					};
				} catch (e) {
					return {
						ok: false,
						message: e instanceof Error ? e.message : "ClickUp didn't answer",
					};
				}
			},
			render: (w) => (
				<div className="grid gap-5">
					<Instructions
						href="https://app.clickup.com/settings/apps"
						link="Open ClickUp settings"
					>
						<p>
							In ClickUp, open <strong>Settings → Apps</strong> and generate a{" "}
							<strong>personal API token</strong>. It starts with{" "}
							<code className="font-mono text-foreground">pk_</code>.
						</p>
					</Instructions>
					<Field id="cu-token" label="API token" error={w.error("token")}>
						<Input
							{...w.bind("token")}
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder="pk_…"
							autoFocus
						/>
					</Field>
					<TestPanel
						w={w}
						idle="Check the token reaches ClickUp before going on."
					/>
				</div>
			),
		},
		{
			id: "choose",
			title: "Choose",
			description:
				"Pick the lists to bring over. Each folder (or a space's loose lists) becomes one project.",
			schema: z.object({
				teamId: z.string().min(1, "Pick a workspace"),
				listIds: z.array(z.string()).min(1, "Pick at least one list"),
				targets: z
					.record(
						z.string(),
						z.object({ mode: z.string(), projectId: z.string() }).loose(),
					)
					.refine(
						(t) =>
							Object.values(t).every(
								(x) => x.mode !== "existing" || !!x.projectId,
							),
						"Pick the existing project for every group",
					),
			}),
			render: (w) => <ChooseStep w={w} teams={teams} />,
		},
		{
			id: "statuses",
			title: "Statuses",
			description:
				"ClickUp statuses live on each list; here is their union. Same-named statuses reuse yours.",
			render: (w) => <StatusesStep w={w} />,
		},
		{
			id: "fields",
			title: "Fields",
			description:
				"Custom fields with an equivalent import as fields; the rest can come over as a text snapshot.",
			render: (w) => <FieldsStep w={w} />,
		},
		{
			id: "people",
			title: "People",
			description:
				"Matched by email. Unmatched people's tasks stay unassigned with a note naming them.",
			render: (w) => <PeopleStep w={w} />,
		},
		{
			id: "options",
			title: "Options",
			render: (w) => (
				<div className="grid divide-y rounded-lg ring-1 ring-border">
					{OPTIONS.map((o) => (
						<div
							key={o.key}
							className="flex items-start justify-between gap-4 px-4 py-3"
						>
							<label htmlFor={`cu-opt-${o.key}`} className="grid gap-0.5">
								<span className="text-sm font-medium">{o.label}</span>
								<span className="text-sm text-muted-foreground">{o.hint}</span>
							</label>
							<Switch
								id={`cu-opt-${o.key}`}
								checked={w.values.options[o.key]}
								onCheckedChange={(c) =>
									w.set("options", { ...w.values.options, [o.key]: c })
								}
							/>
						</div>
					))}
				</div>
			),
		},
		{
			id: "dry-run",
			title: "Dry run",
			description:
				"Reads everything without writing, then counts what will be created.",
			test: async (v) => {
				try {
					const imp = await api.work.imports.create({
						kind: "clickup",
						config: configOf(v),
					});
					await api.work.imports.dryRun(imp.id);
					for (let i = 0; i < 600; i++) {
						await new Promise((r) => setTimeout(r, 1000));
						const cur = await api.work.imports.get(imp.id);
						if (cur.status === "ready" && cur.plan) {
							setDry({ importId: imp.id, plan: cur.plan });
							const n =
								(cur.plan.counts.tasks ?? 0) + (cur.plan.counts.subtasks ?? 0);
							return {
								ok: true,
								message: `Ready to import ${n.toLocaleString()} tasks`,
								detail: cur.plan.warnings.length
									? "Read the notes below before going on."
									: undefined,
							};
						}
						if (cur.status === "failed")
							return {
								ok: false,
								message: "The dry run stopped",
								detail: cur.plan?.warnings.at(-1),
							};
					}
					return {
						ok: false,
						message: "The dry run is taking too long; try fewer lists",
					};
				} catch (e) {
					return {
						ok: false,
						message: e instanceof Error ? e.message : "The dry run failed",
					};
				}
			},
			render: (w) => (
				<div className="grid gap-5">
					<TestPanel
						w={w}
						action="Start dry run"
						idle="Nothing is written. Large workspaces take a few minutes: ClickUp allows about 100 requests a minute."
					/>
					{w.test.phase === "passed" && dry && (
						<div className="t-reveal">
							<ImportPlan plan={dry.plan} />
						</div>
					)}
				</div>
			),
		},
		{
			id: "import",
			title: "Import",
			render: (w) => {
				const cfg = configOf(w.values);
				return (
					<Summary
						w={w}
						sections={[
							{
								stepId: "choose",
								title: "Into",
								rows: cfg.targets.map((t) => ({
									label: `${t.listIds.length} ${t.listIds.length === 1 ? "list" : "lists"}`,
									value:
										t.target.kind === "new"
											? `New project “${t.target.name}”`
											: "An existing project",
								})),
							},
							{
								stepId: "dry-run",
								title: "What comes over",
								rows: dry
									? Object.entries(dry.plan.counts).map(([k, n]) => ({
											label: entityLabel(k),
											value: n.toLocaleString(),
										}))
									: [{ label: "Dry run", value: "Not run" }],
							},
							{
								stepId: "options",
								title: "Options",
								rows: [
									{
										label: "Includes",
										value:
											OPTIONS.filter((o) => w.values.options[o.key])
												.map((o) => o.label)
												.join(", ") || "Tasks only",
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
		<Wizard
			id="work-import-clickup"
			steps={steps}
			defaultValues={
				{
					token: "",
					teamId: "",
					listIds: [],
					targets: {},
					statuses: {},
					fields: {},
					people: {},
					options: {
						closedTasks: true,
						comments: true,
						attachments: true,
						timeEntries: true,
						archivedLists: false,
						keepUrls: true,
					},
				} as V
			}
			secretKeys={["token"]}
			step={step}
			onStepChange={onStepChange}
			finishLabel="Start import"
			onComplete={async () => {
				if (!dry) throw new Error("Run the dry run first.");
				await api.work.imports.run(dry.importId);
				await qc.invalidateQueries({ queryKey: ["work", "imports"] });
				await navigate({
					to: "/work/import/$importId",
					params: { importId: dry.importId },
				});
			}}
		/>
	);
}

function ChooseStep({
	w,
	teams,
}: {
	w: WizardApi<V>;
	teams: { id: string; name: string }[];
}) {
	const teamId =
		w.values.teamId || (teams.length === 1 ? (teams[0]?.id ?? "") : "");
	if (teamId && teamId !== w.values.teamId)
		queueMicrotask(() => w.set("teamId", teamId));
	const tree = useQuery(treeQuery(w.values.token, teamId));
	const projects = useWorkProjects().data ?? [];
	const groups = groupsOf(tree.data ?? []);
	const selected = new Set(w.values.listIds);
	const toggle = (ids: string[], on: boolean) =>
		w.set(
			"listIds",
			on
				? [...new Set([...w.values.listIds, ...ids])]
				: w.values.listIds.filter((x) => !ids.includes(x)),
		);
	const target = (g: Group): Target =>
		w.values.targets[g.id] ?? { mode: "new", name: g.name, projectId: "" };
	const setTarget = (g: Group, t: Partial<Target>) =>
		w.set("targets", { ...w.values.targets, [g.id]: { ...target(g), ...t } });

	return (
		<div className="grid gap-5">
			{teams.length > 1 && (
				<Field id="cu-team" label="Workspace" error={w.error("teamId")}>
					<Select
						value={w.values.teamId}
						onValueChange={(v) => w.set("teamId", v)}
					>
						<SelectTrigger id="cu-team" className="w-full sm:w-72">
							<SelectValue placeholder="Pick a workspace" />
						</SelectTrigger>
						<SelectContent>
							{teams.map((t) => (
								<SelectItem key={t.id} value={t.id}>
									{t.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			)}
			{tree.isPending && teamId ? (
				<div className="grid gap-2">
					<Skeleton className="h-16" />
					<Skeleton className="h-16" />
				</div>
			) : tree.isError ? (
				<p className="text-sm text-bad-text">{tree.error.message}</p>
			) : (
				<div className="grid gap-3">
					{groups.map((g) => {
						const ids = g.lists
							.filter((l) => !l.archived || w.values.options.archivedLists)
							.map((l) => l.id);
						const picked = ids.filter((id) => selected.has(id));
						const t = target(g);
						return (
							<section
								key={g.id}
								className={cn(
									"rounded-lg ring-1 ring-border transition-shadow",
									picked.length && "ring-brand/40",
								)}
							>
								<label
									htmlFor={`cu-group-${g.id}`}
									className="flex items-center gap-3 px-4 py-3"
								>
									<Checkbox
										id={`cu-group-${g.id}`}
										checked={
											picked.length === 0
												? false
												: picked.length === ids.length
													? true
													: "indeterminate"
										}
										onCheckedChange={(c) => toggle(ids, c === true)}
										aria-label={`All lists in ${g.name}`}
									/>
									<span className="flex-1 text-sm font-medium">{g.name}</span>
									<span className="text-xs text-muted-foreground">
										{g.type === "folder" ? "Folder" : "Space"}
									</span>
								</label>
								<ul className="grid gap-1 border-t px-4 py-2.5 sm:grid-cols-2">
									{g.lists.map((l) => (
										<li key={l.id}>
											<label
												htmlFor={`cu-list-${l.id}`}
												className={cn(
													"flex items-center gap-2 py-1 text-sm",
													l.archived &&
														!w.values.options.archivedLists &&
														"opacity-50",
												)}
											>
												<Checkbox
													id={`cu-list-${l.id}`}
													checked={selected.has(l.id)}
													disabled={
														l.archived && !w.values.options.archivedLists
													}
													onCheckedChange={(c) => toggle([l.id], c === true)}
												/>
												<span className="truncate">{l.name}</span>
												<span className="ml-auto text-xs text-muted-foreground tabular-nums">
													{l.archived ? "Archived" : (l.taskCount ?? "")}
												</span>
											</label>
										</li>
									))}
								</ul>
								{picked.length > 0 && (
									<div className="t-reveal grid gap-3 border-t bg-muted/40 px-4 py-3">
										<ChoiceGroup
											label={`Where ${g.name} goes`}
											columns={2}
											value={t.mode}
											onChange={(mode) => setTarget(g, { mode })}
											choices={[
												{
													value: "new",
													title: "New project",
													description: "Created when the import runs.",
													icon: FolderPlus,
												},
												{
													value: "existing",
													title: "Existing project",
													description: "Its lists are added next to yours.",
													icon: FolderSymlink,
												},
											]}
										/>
										{t.mode === "new" ? (
											<Input
												aria-label="New project name"
												value={t.name}
												onChange={(e) => setTarget(g, { name: e.target.value })}
											/>
										) : (
											<Select
												value={t.projectId}
												onValueChange={(projectId) =>
													setTarget(g, { projectId })
												}
											>
												<SelectTrigger
													aria-label="Existing project"
													className="w-full"
												>
													<SelectValue placeholder="Pick a project" />
												</SelectTrigger>
												<SelectContent>
													{projects.map((p) => (
														<SelectItem key={p.id} value={p.id}>
															{[...p.folderPath, p.name].join(" / ")}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										)}
									</div>
								)}
							</section>
						);
					})}
				</div>
			)}
			{w.error("listIds") && (
				<p className="text-sm text-bad-text">{w.error("listIds")}</p>
			)}
			{w.error("targets") && (
				<p className="text-sm text-bad-text">{w.error("targets")}</p>
			)}
		</div>
	);
}

function useInspection(w: WizardApi<V>) {
	return useQuery(
		inspectQuery(w.values.token, w.values.teamId, w.values.listIds),
	);
}

function Loading({
	q,
}: {
	q: { isPending: boolean; isError: boolean; error: Error | null };
}) {
	if (q.isError)
		return <p className="text-sm text-bad-text">{q.error?.message}</p>;
	return (
		<div className="grid gap-2">
			<Skeleton className="h-10" />
			<Skeleton className="h-10" />
			<Skeleton className="h-10" />
		</div>
	);
}

function MappingTable({
	head,
	children,
}: {
	head: [string, string];
	children: React.ReactNode;
}) {
	return (
		<div className="overflow-hidden rounded-lg ring-1 ring-border">
			<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
				<span>{head[0]}</span>
				<span>{head[1]}</span>
			</div>
			<ul className="divide-y">{children}</ul>
		</div>
	);
}

function Row({
	left,
	sub,
	children,
}: {
	left: string;
	sub?: string;
	children: React.ReactNode;
}) {
	return (
		<li className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4 px-4 py-2.5">
			<span className="min-w-0">
				<span className="block truncate text-sm">{left}</span>
				{sub && (
					<span className="block truncate text-xs text-muted-foreground">
						{sub}
					</span>
				)}
			</span>
			{children}
		</li>
	);
}

function StatusesStep({ w }: { w: WizardApi<V> }) {
	const q = useInspection(w);
	if (!q.data) return <Loading q={q} />;
	return (
		<MappingTable head={["ClickUp status", "Becomes"]}>
			{q.data.statuses.map((s) => (
				<Row key={s.key} left={s.name} sub={`ClickUp type: ${s.type}`}>
					<Select
						value={w.values.statuses[s.key] ?? s.proposed.category}
						onValueChange={(c) =>
							w.set("statuses", {
								...w.values.statuses,
								[s.key]: c as WorkStatusCategory,
							})
						}
					>
						<SelectTrigger
							aria-label={`Category for ${s.name}`}
							className="w-full"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(Object.keys(CATEGORY) as WorkStatusCategory[]).map((c) => (
								<SelectItem key={c} value={c}>
									“{s.proposed.name}” · {CATEGORY[c]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Row>
			))}
		</MappingTable>
	);
}

const KIND_LABEL: Record<string, string> = {
	text: "Text",
	long_text: "Long text",
	number: "Number",
	currency: "Currency",
	percent: "Percent",
	date: "Date",
	checkbox: "Checkbox",
	select: "Select",
	multi_select: "Multi-select",
	user: "Person",
	url: "URL",
	email: "Email",
	phone: "Phone",
	rating: "Rating",
};

function FieldsStep({ w }: { w: WizardApi<V> }) {
	const q = useInspection(w);
	if (!q.data) return <Loading q={q} />;
	if (!q.data.fields.length)
		return (
			<p className="text-sm text-muted-foreground">
				These lists have no custom fields.
			</p>
		);
	return (
		<MappingTable head={["ClickUp field", "Imports as"]}>
			{q.data.fields.map((f: ClickUpInspection["fields"][number]) => (
				<Row
					key={f.id}
					left={f.name}
					sub={f.reason ?? `ClickUp type: ${f.type}`}
				>
					<Select
						value={w.values.fields[f.id] ?? (f.proposed ? "import" : "skip")}
						onValueChange={(m) =>
							w.set("fields", {
								...w.values.fields,
								[f.id]: m as V["fields"][string],
							})
						}
					>
						<SelectTrigger
							aria-label={`How to import ${f.name}`}
							className="w-full"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{f.proposed && (
								<SelectItem value="import">
									{KIND_LABEL[f.proposed.kind] ?? f.proposed.kind} field
								</SelectItem>
							)}
							<SelectItem value="text_snapshot">Text snapshot</SelectItem>
							<SelectItem value="skip">Skip</SelectItem>
						</SelectContent>
					</Select>
				</Row>
			))}
		</MappingTable>
	);
}

function PeopleStep({ w }: { w: WizardApi<V> }) {
	const q = useInspection(w);
	if (!q.data) return <Loading q={q} />;
	const { members, orgMembers } = q.data;
	return (
		<MappingTable head={["ClickUp member", "Assigned to"]}>
			{members.map((m) => (
				<Row key={m.id} left={m.username} sub={m.email ?? undefined}>
					<Select
						value={w.values.people[m.id] ?? m.matchUserId ?? "unassigned"}
						onValueChange={(v) =>
							w.set("people", { ...w.values.people, [m.id]: v })
						}
					>
						<SelectTrigger
							aria-label={`Who ${m.username} becomes`}
							className="w-full"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{orgMembers.map((o) => (
								<SelectItem key={o.userId} value={o.userId}>
									{o.name}
								</SelectItem>
							))}
							<SelectSeparator />
							<SelectItem value="unassigned">Leave unassigned</SelectItem>
							{m.email && (
								<SelectItem value="invite">Invite {m.email}</SelectItem>
							)}
						</SelectContent>
					</Select>
				</Row>
			))}
		</MappingTable>
	);
}
