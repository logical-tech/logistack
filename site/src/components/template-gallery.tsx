"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { TemplateLogo } from "./template-logo";

export type GalleryItem = {
	id: string;
	name: string;
	description: string;
	category: string;
	tags: string[];
	logo?: string;
	services: number;
};

export function TemplateGallery({
	items,
	categories,
}: {
	items: GalleryItem[];
	categories: [id: string, label: string, count: number][];
}) {
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState("all");
	const q = useDeferredValue(query.trim().toLowerCase());

	// Restore a shared link such as /templates/?q=postgres&c=database.
	useEffect(() => {
		const p = new URLSearchParams(window.location.search);
		setQuery(p.get("q") ?? "");
		const c = p.get("c");
		if (c && categories.some(([id]) => id === c)) setCategory(c);
	}, [categories]);

	useEffect(() => {
		const p = new URLSearchParams();
		if (q) p.set("q", q);
		if (category !== "all") p.set("c", category);
		const s = p.toString();
		window.history.replaceState(
			null,
			"",
			s ? `?${s}` : window.location.pathname,
		);
	}, [q, category]);

	const shown = useMemo(
		() =>
			items.filter(
				(t) =>
					(category === "all" || t.category === category) &&
					(!q ||
						t.name.toLowerCase().includes(q) ||
						t.description.toLowerCase().includes(q) ||
						t.tags.some((tag) => tag.includes(q))),
			),
		[items, q, category],
	);

	const chips: [string, string, number][] = [
		["all", "All", items.length],
		...categories,
	];

	return (
		<div className="flex flex-col gap-8">
			<div className="sticky top-[72px] z-20 -mx-4 flex flex-col gap-4 bg-bg px-4 pt-2 pb-4 sm:-mx-10 sm:px-10">
				<label className="flex h-14 items-center gap-3 rounded-2xl bg-surface px-5 focus-within:shadow-[inset_0_0_0_1.5px_var(--color-brand)]">
					<svg
						viewBox="0 0 24 24"
						aria-hidden
						className="size-5 shrink-0 text-faint"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
					>
						<circle cx="11" cy="11" r="7" />
						<path d="m20 20-3.5-3.5" />
					</svg>
					<span className="sr-only">Search templates</span>
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search by name, use or tag: postgres, wiki, invoices…"
						className="h-full min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
						autoComplete="off"
						spellCheck={false}
					/>
					{query && (
						<button
							type="button"
							onClick={() => setQuery("")}
							className="pressable -mr-2 flex size-10 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg"
						>
							<span className="sr-only">Clear search</span>
							<svg
								viewBox="0 0 24 24"
								aria-hidden
								className="size-4"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
							>
								<path d="M18 6 6 18M6 6l12 12" />
							</svg>
						</button>
					)}
				</label>
				<fieldset className="-mx-4 min-w-0 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
					<legend className="sr-only">Category</legend>
					<div className="flex w-max gap-2 sm:w-auto sm:flex-wrap">
						{chips.map(([id, label, count]) => (
							<label
								key={id}
								className={`pressable relative flex h-9 cursor-pointer items-center gap-2 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand ${category === id ? "bg-fg text-bg" : "bg-raised text-muted hover:text-fg"}`}
							>
								<input
									type="radio"
									name="category"
									value={id}
									checked={category === id}
									onChange={() => setCategory(id)}
									className="sr-only"
								/>
								{label}
								<span
									className={`tabular-nums ${category === id ? "text-bg/60" : "text-faint"}`}
								>
									{count}
								</span>
							</label>
						))}
					</div>
				</fieldset>
			</div>

			<p aria-live="polite" className="text-sm text-muted tabular-nums">
				{shown.length === items.length
					? `${items.length} templates`
					: `${shown.length} of ${items.length} templates`}
			</p>

			{shown.length > 0 ? (
				<ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{shown.map((t) => (
						<li key={t.id} className="min-w-0">
							<a
								href={`/templates/${t.id}/`}
								className="group flex h-full flex-col gap-4 rounded-[18px] bg-step p-5 transition-colors duration-150 hover:bg-tile"
							>
								<span className="flex items-center gap-3.5">
									<TemplateLogo name={t.name} logo={t.logo} />
									<span className="flex min-w-0 flex-col">
										<span className="truncate text-[15px] font-medium">
											{t.name}
										</span>
										<span className="text-xs text-faint">
											{t.services === 1
												? "1 service"
												: `${t.services} services`}
										</span>
									</span>
								</span>
								<span className="line-clamp-3 text-sm leading-relaxed text-muted">
									{t.description}
								</span>
							</a>
						</li>
					))}
				</ul>
			) : (
				<div className="flex flex-col items-start gap-4 rounded-[20px] bg-step p-8">
					<p className="text-lg font-medium">
						Nothing in the catalog matches “{query}”.
					</p>
					<p className="max-w-[56ch] text-[15px] leading-relaxed text-muted">
						Any app with a Docker image or a compose file still deploys: paste
						the compose file into a new stack, or point a service at the image.
					</p>
					<button
						type="button"
						onClick={() => {
							setQuery("");
							setCategory("all");
						}}
						className="pressable inline-flex h-10 items-center rounded-full bg-fg px-4 text-sm font-medium text-bg hover:bg-white"
					>
						Show all templates
					</button>
				</div>
			)}
		</div>
	);
}
