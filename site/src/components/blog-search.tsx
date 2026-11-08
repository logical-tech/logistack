"use client";

import { type ReactNode, useDeferredValue, useEffect, useState } from "react";

export type SearchPost = {
	slug: string;
	title: string;
	description: string;
	category: string;
	keywords: string[];
	minutes: number;
};

export function matches(p: SearchPost, q: string): boolean {
	const hay = [p.title, p.description, p.category, ...p.keywords]
		.join(" ")
		.toLowerCase();
	return q.split(/\s+/).every((w) => hay.includes(w));
}

/** Search box over the blog; while a query is set, results replace `children` (the topic sections). */
export function BlogSearch({
	posts,
	children,
}: {
	posts: SearchPost[];
	children: ReactNode;
}) {
	const [query, setQuery] = useState("");
	const q = useDeferredValue(query.trim().toLowerCase());

	// Restore a shared link such as /blog/?q=postgres.
	useEffect(() => {
		setQuery(new URLSearchParams(window.location.search).get("q") ?? "");
	}, []);

	useEffect(() => {
		window.history.replaceState(
			null,
			"",
			q ? `?q=${encodeURIComponent(q)}` : window.location.pathname,
		);
	}, [q]);

	const shown = q ? posts.filter((p) => matches(p, q)) : posts;

	return (
		<>
			<div className="mx-auto w-full max-w-[1440px] px-4 sm:px-10">
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
					<span className="sr-only">Search the blog</span>
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => e.key === "Escape" && setQuery("")}
						placeholder="Search guides: postgres, backups, traefik…"
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
				<p aria-live="polite" className="sr-only">
					{q ? `${shown.length} of ${posts.length} posts` : ""}
				</p>
			</div>

			{/* Sections stay in the DOM for crawlers; hidden only while searching. */}
			<div hidden={!!q}>{children}</div>

			{q && (
				<div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 pt-10 sm:px-10">
					<p className="text-sm text-muted tabular-nums">
						{shown.length} of {posts.length} posts
					</p>
					{shown.length > 0 ? (
						<ul className="flex flex-col">
							{shown.map((p) => (
								<li key={p.slug}>
									<a
										href={`/blog/${p.slug}/`}
										className="-mx-4 flex flex-col gap-1.5 rounded-[18px] px-4 py-4 transition-colors duration-150 hover:bg-raised"
									>
										<span className="text-[19px] leading-snug font-medium tracking-[-0.01em]">
											{p.title}
										</span>
										<span className="max-w-[70ch] text-[15px] leading-relaxed text-muted">
											{p.description}
										</span>
										<span className="text-[13px] text-faint tabular-nums">
											{p.category} · {p.minutes} min read
										</span>
									</a>
								</li>
							))}
						</ul>
					) : (
						<div className="flex flex-col items-start gap-4 rounded-[20px] bg-step p-8">
							<p className="text-lg font-medium">
								No posts match “{query.trim()}”.
							</p>
							<button
								type="button"
								onClick={() => setQuery("")}
								className="pressable inline-flex h-10 items-center rounded-full bg-fg px-4 text-sm font-medium text-bg hover:bg-white"
							>
								Show all posts
							</button>
						</div>
					)}
				</div>
			)}
		</>
	);
}
