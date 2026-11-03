import {
	type TemplateCategory,
	type TemplateSummary,
	templateCategories,
} from "@logistack/contracts";
import { Link } from "@tanstack/react-router";
import { Search, SearchX, X } from "lucide-react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import {
	type KeyboardEvent,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import type { EnvironmentId, ProjectId } from "@/lib/api/types";
import {
	CATEGORY_LABEL,
	categoryCounts,
	searchTemplates,
} from "@/lib/templates";
import { cn } from "@/lib/utils";
import { TemplateLogo } from "./template-logo";

const STEP: Record<string, (i: number, cols: number, n: number) => number> = {
	ArrowRight: (i) => i + 1,
	ArrowLeft: (i) => i - 1,
	ArrowDown: (i, c) => i + c,
	ArrowUp: (i, c) => i - c,
	Home: () => 0,
	End: (_, __, n) => n - 1,
};

/** Columns in a wrapping grid: how many tiles share the first one's row. */
function columnsOf(tiles: HTMLElement[]) {
	const top = tiles[0]?.offsetTop;
	let n = 0;
	while (n < tiles.length && tiles[n]?.offsetTop === top) n += 1;
	return Math.max(1, n);
}

export function TemplateGallery({
	templates,
	projectId,
	environmentId,
	query,
	category,
	onQueryChange,
	onCategoryChange,
}: {
	templates: TemplateSummary[] | undefined;
	projectId: ProjectId;
	environmentId: EnvironmentId;
	query: string;
	category: TemplateCategory | undefined;
	onQueryChange: (q: string) => void;
	onCategoryChange: (c: TemplateCategory | undefined) => void;
}) {
	const searchRef = useRef<HTMLInputElement>(null);
	const gridRef = useRef<HTMLUListElement>(null);
	const deferred = useDeferredValue(query);
	const matches = useMemo(
		() => (templates ? searchTemplates(templates, deferred) : undefined),
		[templates, deferred],
	);
	const counts = useMemo(() => categoryCounts(matches ?? []), [matches]);
	const visible = useMemo(
		() => matches?.filter((t) => !category || t.category === category),
		[matches, category],
	);
	// Roving focus: one tile is in the tab order, arrows move between them.
	const [active, setActive] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new result set starts at its first tile
	useEffect(() => setActive(0), [visible]);

	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			const editing = target?.closest(
				"input, textarea, select, [contenteditable=true]",
			);
			if (e.key === "/" && !editing && !e.metaKey && !e.ctrlKey) {
				e.preventDefault();
				searchRef.current?.focus();
				searchRef.current?.select();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const tiles = () => [
		...(gridRef.current?.querySelectorAll<HTMLElement>("[data-tile]") ?? []),
	];

	function onGridKey(e: KeyboardEvent) {
		const step = STEP[e.key];
		const all = tiles();
		const i = all.indexOf(document.activeElement as HTMLElement);
		if (!step || i < 0) return;
		e.preventDefault();
		const next = step(i, columnsOf(all), all.length);
		if (next < 0 && e.key === "ArrowUp") return searchRef.current?.focus();
		all[Math.min(Math.max(next, 0), all.length - 1)]?.focus();
	}

	function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Escape" && (query || category)) {
			e.preventDefault();
			onQueryChange("");
			onCategoryChange(undefined);
		}
		if (e.key === "ArrowDown" || (e.key === "Enter" && visible?.length)) {
			e.preventDefault();
			tiles()[0]?.focus();
		}
	}

	const total = matches?.length ?? 0;
	const elsewhere = category && visible?.length === 0 ? total : 0;

	return (
		<div className="grid grid-cols-1 gap-5">
			<div className="grid grid-cols-1 gap-3">
				<div className="relative">
					<Search
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						aria-hidden
					/>
					<Input
						ref={searchRef}
						type="search"
						aria-label="Search templates"
						aria-controls="template-grid"
						placeholder="Search by name, tag or purpose"
						value={query}
						onChange={(e) => onQueryChange(e.target.value)}
						onKeyDown={onSearchKey}
						className="h-10 pr-16 pl-9 text-sm [&::-webkit-search-cancel-button]:hidden"
					/>
					<div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center">
						{query ? (
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Clear search"
								onClick={() => {
									onQueryChange("");
									searchRef.current?.focus();
								}}
							>
								<X />
							</Button>
						) : (
							<Kbd className="max-sm:hidden">/</Kbd>
						)}
					</div>
				</div>

				<ToggleGroupPrimitive.Root
					type="single"
					value={category ?? "all"}
					onValueChange={(v) =>
						v &&
						onCategoryChange(v === "all" ? undefined : (v as TemplateCategory))
					}
					aria-label="Category"
					className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
				>
					{(["all", ...templateCategories] as const).map((c) => {
						const n = c === "all" ? total : (counts.get(c) ?? 0);
						if (c !== "all" && n === 0 && category !== c) return null;
						return (
							<ToggleGroupPrimitive.Item
								key={c}
								value={c}
								className={cn(
									"inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium whitespace-nowrap text-muted-foreground ring-1 ring-border outline-none t-press",
									"transition-[color,background-color,box-shadow] duration-(--duration-quick) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
									"data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:ring-foreground",
								)}
							>
								{c === "all" ? "All" : CATEGORY_LABEL[c]}
								<span className="tabular opacity-60">{n}</span>
							</ToggleGroupPrimitive.Item>
						);
					})}
				</ToggleGroupPrimitive.Root>
			</div>

			<p className="sr-only" aria-live="polite">
				{visible ? `${visible.length} templates` : "Loading templates"}
			</p>

			{!visible ? (
				<ul
					className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
					aria-hidden
				>
					{Array.from({ length: 9 }, (_, i) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
							key={i}
							className="flex h-32 gap-3 rounded-xl bg-card p-4 ring-1 ring-border"
						>
							<span className="t-skel size-10 rounded-lg bg-muted-foreground/15" />
							<span className="grid grid-cols-1 flex-1 content-start gap-2 pt-1">
								<span className="t-skel h-3.5 w-2/5 rounded bg-muted-foreground/15" />
								<span className="t-skel h-3 w-4/5 rounded bg-muted-foreground/10" />
								<span className="t-skel h-3 w-3/5 rounded bg-muted-foreground/10" />
							</span>
						</li>
					))}
				</ul>
			) : visible.length === 0 ? (
				<EmptyState
					icon={SearchX}
					title={
						query ? `No templates match “${query.trim()}”` : "Nothing here yet"
					}
					description={
						elsewhere
							? `${elsewhere} ${elsewhere === 1 ? "template matches" : "templates match"} in other categories.`
							: "Try the product's name, like n8n or Plausible, or what it does, like analytics or backups."
					}
				>
					{elsewhere ? (
						<Button
							variant="outline"
							onClick={() => onCategoryChange(undefined)}
						>
							Search all categories
						</Button>
					) : (
						<Button
							variant="outline"
							onClick={() => {
								onQueryChange("");
								onCategoryChange(undefined);
								searchRef.current?.focus();
							}}
						>
							Clear search
						</Button>
					)}
				</EmptyState>
			) : (
				<ul
					ref={gridRef}
					id="template-grid"
					aria-label="Templates"
					onKeyDown={onGridKey}
					className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
				>
					{visible.map((t, i) => (
						<li key={t.id}>
							<Link
								to="/projects/$projectId/templates/$templateId"
								params={{ projectId, templateId: t.id }}
								search={{ env: environmentId }}
								data-tile
								tabIndex={i === active ? 0 : -1}
								onFocus={() => setActive(i)}
								className={cn(
									// Skips layout and paint for the off-screen tiles of a 500-row grid.
									"group flex h-full gap-3 rounded-xl bg-card p-4 shadow-card ring-1 ring-border outline-none [contain-intrinsic-size:auto_8rem] [content-visibility:auto]",
									"transition-[box-shadow] duration-(--duration-quick) hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring",
								)}
							>
								<TemplateLogo template={t} />
								<span className="grid grid-cols-1 min-w-0 flex-1 content-start gap-1">
									<span className="flex items-baseline justify-between gap-2">
										<span className="truncate text-sm font-medium">
											{t.name}
										</span>
										{t.services > 1 && (
											<span className="shrink-0 text-xs text-muted-foreground tabular">
												{t.services} services
											</span>
										)}
									</span>
									<span className="line-clamp-2 text-xs leading-relaxed text-pretty text-muted-foreground">
										{t.description}
									</span>
									{t.tags.length > 0 && (
										<span className="mt-1.5 flex min-w-0 flex-wrap gap-1 overflow-hidden [max-height:1.25rem]">
											{t.tags.slice(0, 3).map((tag) => (
												<span
													key={tag}
													className="rounded-sm bg-muted px-1.5 py-px text-2xs text-muted-foreground"
												>
													{tag}
												</span>
											))}
										</span>
									)}
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
