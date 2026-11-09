/*
 * ViewHost: one saved view of a project, with everything the viewer can change on top of it
 * (filter, search, sort, group, columns or card fields, closed tasks, subtasks). Changes stay
 * unsaved until "Save view"; the filter and the search live in the URL so the page is shareable.
 * The view itself renders through the registry by `view.kind`.
 */
import type {
	FilterNode,
	GroupKey,
	SortKey,
	WorkTaskListQuery,
	WorkView,
	WorkViewConfig,
} from "@logistack/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
	ArrowDownUp,
	Columns3,
	Download,
	Layers,
	Plus,
	Search,
	SlidersHorizontal,
	X,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useMe } from "@/lib/api/access";
import {
	useCreateWorkView,
	useUpdateWorkView,
	useWorkTasks,
	useWorkViews,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import {
	effectiveColumns,
	groupKeys,
	sortKeys,
	toConfigColumns,
} from "./columns";
import { FilterBar } from "./filter-builder";
import {
	andNodes,
	completeOnly,
	toNode,
	toUi,
	type UiFilter,
} from "./filter-model";
import { viewRoute, type WorkBase } from "./links";
import { ColorDot } from "./parts";
import { ProjectHeader } from "./project-header";
import { useShortcut } from "./shortcuts";
import { useOpenTask } from "./task-sheet/open-task";
import { useQuickCreate, useWorkProjectContext } from "./use-work-project";
import { useWorkSubscription } from "./use-work-subscription";
import { VIEW_COMPONENTS } from "./views/registry";
import type { WorkProjectContext } from "./views/types";

export const viewSearch = z.object({
	/** Ad-hoc filter as compact JSON (`null` = cleared); absent = the view's saved filter. */
	filter: z.string().optional().catch(undefined),
	q: z.string().optional().catch(undefined),
	list: z.string().optional().catch(undefined),
});
type ViewSearch = z.infer<typeof viewSearch>;

const parseFilter = (
	raw: string | undefined,
): FilterNode | null | undefined => {
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw) as FilterNode | null;
	} catch {
		return undefined;
	}
};

const same = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

export function ViewHost({
	projectId,
	viewId,
	base,
}: {
	projectId: string;
	viewId: string;
	base: WorkBase;
}) {
	const { data: project, error } = useWorkProjectContext(projectId);
	const { data: views } = useWorkViews(projectId);
	const navigate = useNavigate();
	useWorkSubscription(projectId);
	const view = views?.find((v) => v.id === viewId);

	// A deleted or foreign view id falls back to the project's default view.
	useEffect(() => {
		if (!views || view) return;
		const fallback = views.find((v) => v.isDefault) ?? views[0];
		if (fallback)
			navigate({
				to: viewRoute(base),
				params: { projectId, viewId: fallback.id },
				replace: true,
			});
	}, [views, view, navigate, base, projectId]);

	if (error)
		return (
			<Page>
				<EmptyState
					icon={Layers}
					title="These tasks didn't load"
					description={
						error instanceof Error ? error.message : "Try again in a moment."
					}
				/>
			</Page>
		);
	if (!project || !view)
		return (
			<Page className="max-w-none">
				<Skeleton className="mb-3 h-8 w-56" />
				<Skeleton className="mb-6 h-9 w-96" />
				<Skeleton className="h-96 w-full" />
			</Page>
		);
	return (
		<Page className="max-w-none">
			<ProjectHeader project={project} base={base} current={view.id} />
			<div
				id="work-view-panel"
				role="tabpanel"
				aria-labelledby={`work-view-tab-${view.id}`}
			>
				<ViewBody key={view.id} project={project} view={view} base={base} />
			</div>
		</Page>
	);
}

function ViewBody({
	project,
	view,
	base,
}: {
	project: WorkProjectContext;
	view: WorkView;
	base: WorkBase;
}) {
	const search = useSearch({ strict: false }) as ViewSearch & { task?: string };
	const navigate = useNavigate();
	const { data: me } = useMe();
	const openTask = useOpenTask();
	const setSearch = (patch: Partial<ViewSearch>) =>
		navigate({
			to: viewRoute(base),
			params: { projectId: project.id, viewId: view.id },
			search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
			replace: true,
		} as never);

	// Unsaved changes other than the filter (which lives in the URL).
	const [draft, setDraft] = useState<Partial<WorkViewConfig>>({});
	const urlFilter = parseFilter(search.filter);
	const [filterUi, setFilterUi] = useState<UiFilter>(() =>
		toUi(urlFilter !== undefined ? urlFilter : view.config.filter),
	);
	const config: WorkViewConfig = useMemo(
		() => ({
			...view.config,
			...draft,
			filter: urlFilter !== undefined ? urlFilter : view.config.filter,
		}),
		[view.config, draft, urlFilter],
	);
	const dirty = !same(config, view.config);

	const onFilterChange = (ui: UiFilter) => {
		setFilterUi(ui);
		const node = toNode(completeOnly(ui));
		setSearch({
			filter: same(node, view.config.filter) ? undefined : JSON.stringify(node),
		});
	};

	// Search: typed locally, written to the URL after a pause.
	const [q, setQ] = useState(search.q ?? "");
	const latest = useRef({ urlQ: search.q, setSearch });
	latest.current = { urlQ: search.q, setSearch };
	useEffect(() => {
		const t = setTimeout(() => {
			const { urlQ, setSearch } = latest.current;
			if ((urlQ ?? "") !== q.trim()) setSearch({ q: q.trim() || undefined });
		}, 250);
		return () => clearTimeout(t);
	}, [q]);
	const searchRef = useRef<HTMLInputElement>(null);
	useShortcut("/", () => searchRef.current?.focus());

	const listId = search.list;
	const query: WorkTaskListQuery = useMemo(() => {
		const text = search.q?.trim();
		const filter = andNodes(
			config.filter,
			text ? { key: "text", op: "contains", value: text } : null,
		);
		return {
			projectId: project.id,
			...(listId ? { listId } : {}),
			...(filter ? { filter: JSON.stringify(filter) } : {}),
			...(config.sort.length ? { sort: JSON.stringify(config.sort) } : {}),
			includeClosed: config.showClosed ? "true" : "false",
			...(config.showSubtasks === "flat" ? {} : { topLevel: "true" as const }),
			include: "fields,assignees,tags,counts",
			limit: 200,
		};
	}, [project.id, listId, config, search.q]);
	const result = useWorkTasks(query);
	const items = useMemo(
		() => result.data?.pages.flatMap((p) => p.items) ?? [],
		[result.data],
	);

	const create = useQuickCreate(project, listId ?? view.listId);
	useShortcut("c", () => {
		if (!project.canEdit) return;
		window.dispatchEvent(new CustomEvent("work:quick-add"));
	});

	const patch = (p: Partial<WorkViewConfig>) =>
		setDraft((d) => ({ ...d, ...p }));
	const reset = () => {
		setDraft({});
		setFilterUi(toUi(view.config.filter));
		setSearch({ filter: undefined });
	};

	const ViewComponent = VIEW_COMPONENTS[view.kind];
	const isOwn = view.ownerId !== null && view.ownerId === me?.userId;
	const canSave = project.canAdmin || isOwn;

	return (
		<>
			<div className="mb-4 flex flex-wrap items-center gap-2">
				<FilterBar value={filterUi} onChange={onFilterChange} ctx={project} />
				<div className="ml-auto flex flex-wrap items-center gap-1.5">
					<div className="relative">
						<Search
							className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
							aria-hidden
						/>
						<Input
							ref={searchRef}
							value={q}
							onChange={(e) => setQ(e.target.value)}
							onKeyDown={(e) => {
								if (e.key !== "Escape") return;
								setQ("");
								e.currentTarget.blur();
							}}
							placeholder="Search tasks"
							aria-label="Search tasks"
							className="h-7 w-44 pl-8 text-sm"
						/>
						{q && (
							<button
								type="button"
								aria-label="Clear search"
								onClick={() => setQ("")}
								className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
							>
								<X className="size-3" />
							</button>
						)}
					</div>
					{project.lists.length > 1 && (
						<Select
							value={listId ?? "all"}
							onValueChange={(v) =>
								setSearch({ list: v === "all" ? undefined : v })
							}
						>
							<SelectTrigger size="sm" aria-label="List" className="h-7">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All lists</SelectItem>
								{project.lists.map((l) => (
									<SelectItem key={l.id} value={l.id}>
										<ColorDot color={l.color} />
										{l.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<SortMenu config={config} project={project} onChange={patch} />
					{(view.kind === "table" || view.kind === "board") && (
						<GroupMenu config={config} project={project} onChange={patch} />
					)}
					{view.kind === "table" && (
						<ColumnsMenu config={config} project={project} onChange={patch} />
					)}
					{view.kind === "board" && (
						<CardFieldsMenu
							config={config}
							project={project}
							onChange={patch}
						/>
					)}
					<OptionsMenu config={config} onChange={patch} />
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon-sm" aria-label="Export">
								<Download />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem asChild>
								<a
									href={api.work.tasks.csvUrl({ ...query, format: "csv" })}
									download={`${project.key}-${view.name}.csv`}
								>
									Export CSV
								</a>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					{project.canEdit && (
						<Button
							size="sm"
							onClick={() =>
								window.dispatchEvent(new CustomEvent("work:quick-add"))
							}
						>
							<Plus data-icon="inline-start" />
							Task
						</Button>
					)}
				</div>
			</div>
			<SaveBar
				dirty={dirty}
				canSave={canSave}
				view={view}
				config={config}
				projectId={project.id}
				onReset={reset}
				onSavedAsNew={(v) =>
					navigate({
						to: viewRoute(base),
						params: { projectId: project.id, viewId: v.id },
					})
				}
				onSaved={() => {
					setDraft({});
					setSearch({ filter: undefined });
				}}
			/>
			<Suspense
				fallback={
					<div className="grid h-48 place-items-center">
						<Spinner />
					</div>
				}
			>
				<ViewComponent
					project={project}
					view={view}
					config={config}
					tasks={{
						query,
						items,
						total: result.data?.pages[0]?.total,
						isLoading: result.isLoading,
						hasNextPage: !!result.hasNextPage,
						isFetchingNextPage: result.isFetchingNextPage,
						fetchNextPage: () => void result.fetchNextPage(),
					}}
					onOpenTask={openTask}
					onConfigChange={patch}
					onCreateTask={create}
				/>
			</Suspense>
			{!result.isLoading &&
				items.length === 0 &&
				(search.q || completeOnly(filterUi).items.length > 0) && (
					<div className="mt-4 flex justify-center">
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								setQ("");
								onFilterChange({ mode: "and", items: [] });
							}}
						>
							Clear filters
						</Button>
					</div>
				)}
		</>
	);
}

/** "Save view" when the effective config differs from the saved one. */
function SaveBar({
	dirty,
	canSave,
	view,
	config,
	projectId,
	onReset,
	onSaved,
	onSavedAsNew,
}: {
	dirty: boolean;
	canSave: boolean;
	view: WorkView;
	config: WorkViewConfig;
	projectId: string;
	onReset: () => void;
	onSaved: () => void;
	onSavedAsNew: (v: WorkView) => void;
}) {
	const update = useUpdateWorkView();
	const create = useCreateWorkView();
	return (
		<div
			aria-live="polite"
			className={cn(
				"grid transition-[grid-template-rows,opacity] duration-(--duration-fast) ease-(--ease-smooth-out) motion-reduce:transition-none",
				dirty
					? "mb-3 grid-rows-[1fr] opacity-100"
					: "grid-rows-[0fr] opacity-0",
			)}
		>
			<div className="overflow-hidden">
				{dirty && (
					<div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
						<span className="text-muted-foreground">
							You changed this view. Save it so it opens this way next time?
						</span>
						<div className="ml-auto flex gap-1.5">
							<Button variant="ghost" size="sm" onClick={onReset}>
								Reset
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={create.isPending}
								onClick={async () => {
									try {
										const v = await create.mutateAsync({
											projectId,
											input: {
												name: `${view.name} (copy)`,
												kind: view.kind,
												shared: false,
												config,
											},
										});
										toast.success(`Saved as “${v.name}”`);
										onSavedAsNew(v);
									} catch (e) {
										toast.error("The view wasn't saved", {
											description: e instanceof Error ? e.message : undefined,
										});
									}
								}}
							>
								Save as new
							</Button>
							<Button
								size="sm"
								disabled={!canSave || update.isPending}
								title={
									canSave
										? undefined
										: "Only project managers can change shared views"
								}
								onClick={async () => {
									try {
										await update.mutateAsync({
											projectId,
											id: view.id,
											patch: { config },
										});
										onSaved();
										toast.success("View saved");
									} catch (e) {
										toast.error("The view wasn't saved", {
											description: e instanceof Error ? e.message : undefined,
										});
									}
								}}
							>
								Save
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

type MenuProps = {
	config: WorkViewConfig;
	project: WorkProjectContext;
	onChange: (p: Partial<WorkViewConfig>) => void;
};

function SortMenu({ config, project, onChange }: MenuProps) {
	const keys = sortKeys(project.fields);
	const sort = config.sort;
	const set = (next: typeof sort) => onChange({ sort: next });
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className={cn(sort.length && "text-brand")}
				>
					<ArrowDownUp data-icon="inline-start" />
					Sort
					{sort.length > 0 && <span className="tabular">{sort.length}</span>}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-3">
				<div className="grid gap-2">
					{sort.length === 0 && (
						<p className="text-sm text-muted-foreground">
							Manual order. Drag rows to change it.
						</p>
					)}
					{sort.map((s, i) => (
						<div key={s.by} className="flex items-center gap-1.5">
							<Select
								value={s.by}
								onValueChange={(by) =>
									set(
										sort.map((x, j) =>
											j === i ? { ...x, by: by as SortKey } : x,
										),
									)
								}
							>
								<SelectTrigger
									size="sm"
									className="min-w-0 flex-1"
									aria-label="Sort by"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{keys.map((k) => (
										<SelectItem key={k.key} value={k.key}>
											{k.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Select
								value={s.dir}
								onValueChange={(dir) =>
									set(
										sort.map((x, j) =>
											j === i ? { ...x, dir: dir as "asc" | "desc" } : x,
										),
									)
								}
							>
								<SelectTrigger size="sm" aria-label="Direction">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="asc">Ascending</SelectItem>
									<SelectItem value="desc">Descending</SelectItem>
								</SelectContent>
							</Select>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Remove sort"
								onClick={() => set(sort.filter((_, j) => j !== i))}
							>
								<X />
							</Button>
						</div>
					))}
					{sort.length < 3 && (
						<Button
							variant="ghost"
							size="sm"
							className="justify-self-start"
							onClick={() =>
								set([
									...sort,
									{
										by: (keys.find((k) => !sort.some((s) => s.by === k.key))
											?.key ?? "dueDate") as SortKey,
										dir: "asc",
									},
								])
							}
						>
							<Plus data-icon="inline-start" /> Add sort
						</Button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function GroupMenu({ config, project, onChange }: MenuProps) {
	const keys = groupKeys(project.fields);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm">
					<Layers data-icon="inline-start" />
					Group
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				<DropdownMenuLabel>Group by</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={config.groupBy ?? "none"}
					onValueChange={(v) =>
						onChange({
							groupBy: v === "none" ? null : (v as GroupKey),
							collapsedGroups: [],
						})
					}
				>
					<DropdownMenuRadioItem value="none">
						No grouping
					</DropdownMenuRadioItem>
					{keys.map((k) => (
						<DropdownMenuRadioItem key={k.key} value={k.key}>
							{k.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ColumnsMenu({ config, project, onChange }: MenuProps) {
	const cols = effectiveColumns(config, project.fields);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm">
					<Columns3 data-icon="inline-start" />
					Columns
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="max-h-96 w-60 overflow-y-auto p-1.5"
			>
				<p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
					Drag column headers to reorder them.
				</p>
				{cols.map((c) => {
					const locked = c.key === "key" || c.key === "title";
					return (
						<div
							key={c.key}
							className={cn(
								"flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted",
								locked && "opacity-60",
							)}
						>
							<Checkbox
								id={`col-${c.key}`}
								checked={!c.hidden}
								disabled={locked}
								onCheckedChange={(v) =>
									onChange({
										columns: toConfigColumns(
											cols.map((x) =>
												x.key === c.key ? { ...x, hidden: v !== true } : x,
											),
										),
									})
								}
							/>
							<label htmlFor={`col-${c.key}`} className="flex-1 truncate">
								{c.label}
							</label>
							{c.field && (
								<span className="ml-auto text-2xs text-muted-foreground">
									Field
								</span>
							)}
						</div>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}

function CardFieldsMenu({ config, project, onChange }: MenuProps) {
	const cols = effectiveColumns({ columns: [] }, project.fields).filter(
		(c) => c.key !== "key" && c.key !== "title",
	);
	const chosen = config.cardFields;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm">
					<Columns3 data-icon="inline-start" />
					Card fields
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="max-h-96 w-60 overflow-y-auto p-1.5"
			>
				<p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
					Up to six on each card.
				</p>
				{cols.map((c) => {
					const on = chosen.includes(c.key);
					return (
						<div
							key={c.key}
							className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
						>
							<Checkbox
								id={`card-${c.key}`}
								checked={on}
								disabled={!on && chosen.length >= 6}
								onCheckedChange={(v) =>
									onChange({
										cardFields:
											v === true
												? [...chosen, c.key]
												: chosen.filter((k) => k !== c.key),
									})
								}
							/>
							<label htmlFor={`card-${c.key}`} className="flex-1 truncate">
								{c.label}
							</label>
						</div>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}

function OptionsMenu({
	config,
	onChange,
}: {
	config: WorkViewConfig;
	onChange: (p: Partial<WorkViewConfig>) => void;
}) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="icon-sm" aria-label="View options">
					<SlidersHorizontal />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64 gap-3 p-3">
				<div className="flex items-center justify-between gap-3 text-sm">
					<label htmlFor="work-show-closed">Show closed tasks</label>
					<Switch
						id="work-show-closed"
						checked={config.showClosed}
						onCheckedChange={(v) => onChange({ showClosed: v })}
					/>
				</div>
				<div className="grid gap-1.5">
					<span className="text-sm">Subtasks</span>
					<Select
						value={config.showSubtasks}
						onValueChange={(v) =>
							onChange({ showSubtasks: v as WorkViewConfig["showSubtasks"] })
						}
					>
						<SelectTrigger size="sm" aria-label="Subtasks" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="nested">Under their parent</SelectItem>
							<SelectItem value="flat">As their own rows</SelectItem>
							<SelectItem value="hidden">Hidden</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</PopoverContent>
		</Popover>
	);
}
