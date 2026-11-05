import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import {
	type KeyboardEvent,
	memo,
	type ReactNode,
	useDeferredValue,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { parseAnsi, spanCss } from "@/lib/ansi";
import type { LogLine } from "@/lib/api/service-ops";
import { cn } from "@/lib/utils";

const time = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});

/** Cuts the line's styled runs at every occurrence of `q`, so matches can be marked. */
function segments(raw: string, q: string) {
	const spans = parseAnsi(raw);
	if (!q) return spans.map((s) => ({ ...s, mark: false }));
	const plain = spans.map((s) => s.text).join("");
	const hay = plain.toLowerCase();
	const marks: [number, number][] = [];
	for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length))
		marks.push([i, i + q.length]);
	const out: {
		text: string;
		style: (typeof spans)[number]["style"];
		mark: boolean;
	}[] = [];
	let at = 0;
	for (const span of spans) {
		const end = at + span.text.length;
		let cut = at;
		for (const [a, b] of marks) {
			if (b <= cut || a >= end) continue;
			if (a > cut)
				out.push({ ...span, text: plain.slice(cut, a), mark: false });
			const stop = Math.min(b, end);
			out.push({
				...span,
				text: plain.slice(Math.max(a, cut), stop),
				mark: true,
			});
			cut = stop;
		}
		if (cut < end)
			out.push({ ...span, text: plain.slice(cut, end), mark: false });
		at = end;
	}
	return out;
}

const Row = memo(function Row({
	line,
	number,
	query,
	current,
	showSlot,
	tag,
}: {
	line: LogLine;
	number: number;
	query: string;
	current: boolean;
	showSlot: boolean;
	/** The stream's name column, when lines of several streams are interleaved. */
	tag?: { color: string; width: number };
}) {
	const parts = useMemo(() => segments(line.raw, query), [line.raw, query]);
	return (
		<div
			className={cn(
				"grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-3 sm:px-4",
				!(showSlot || tag) && "max-sm:grid-cols-1",
				current && "bg-[color-mix(in_oklch,var(--brand)_14%,transparent)]",
			)}
		>
			<span
				className={cn(
					"flex gap-3 text-right text-[var(--log-muted)] select-none",
					!(showSlot || tag) && "max-sm:hidden",
				)}
			>
				<span className="w-[4ch] tabular max-sm:hidden">{number}</span>
				{line.at && (
					<time dateTime={line.at} className="tabular max-sm:hidden">
						{time.format(new Date(line.at))}
					</time>
				)}
				{showSlot && <span className="tabular">#{line.slot ?? "?"}</span>}
				{tag && (
					<span
						className="truncate text-left"
						style={{ color: tag.color, width: `${tag.width}ch` }}
					>
						{line.tag}
					</span>
				)}
			</span>
			<span className="break-all whitespace-pre-wrap">
				{parts.map((p, i) =>
					p.mark ? (
						<mark
							// biome-ignore lint/suspicious/noArrayIndexKey: runs of one immutable line
							key={i}
							style={spanCss(p.style)}
							className="rounded-[2px] bg-[color-mix(in_oklch,var(--busy)_45%,transparent)] text-inherit"
						>
							{p.text}
						</mark>
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: runs of one immutable line
						<span key={i} style={spanCss(p.style)}>
							{p.text}
						</span>
					),
				)}
			</span>
		</div>
	);
});

/**
 * A virtualized ANSI log: search with match navigation, copy, and follow, which keeps the
 * newest line in view until the reader scrolls up, and resumes when they scroll back down.
 */
export function LogViewer({
	lines,
	live,
	status,
	toolbar,
	showSlot = false,
	tags,
	empty,
	className,
}: {
	lines: LogLine[];
	/** More lines may still arrive. */
	live: boolean;
	/** One short sentence for the footer: what this stream is and where it stands. */
	status?: ReactNode;
	/** Filters that belong to the stream, drawn before search. */
	toolbar?: ReactNode;
	showSlot?: boolean;
	/** Colours of the streams' tags; a tag column is drawn when given. */
	tags?: Map<string, string>;
	empty: string;
	className?: string;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const userAt = useRef(0);
	const [follow, setFollow] = useState(true);
	const [input, setInput] = useState("");
	const query = useDeferredValue(input.trim().toLowerCase());
	const [cursor, setCursor] = useState(0);
	const tagWidth = Math.min(
		18,
		Math.max(0, ...[...(tags?.keys() ?? [])].map((t) => t.length)),
	);

	const matches = useMemo(() => {
		if (!query) return [];
		const out: number[] = [];
		lines.forEach((l, i) => {
			if (l.plain.toLowerCase().includes(query)) out.push(i);
		});
		return out;
	}, [lines, query]);
	const current = matches.length ? Math.min(cursor, matches.length - 1) : -1;

	const v = useVirtualizer({
		count: lines.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => 20,
		overscan: 24,
		getItemKey: (i) => lines[i]?.key ?? i,
	});
	const total = v.getTotalSize();

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (follow && el && total) el.scrollTop = el.scrollHeight;
	}, [follow, total]);

	function go(delta: number) {
		if (!matches.length) return;
		const next = (current + delta + matches.length) % matches.length;
		setCursor(next);
		setFollow(false);
		v.scrollToIndex(matches[next] as number, { align: "center" });
	}

	function onScroll() {
		const el = scrollRef.current;
		// Only the reader's own scrolling changes follow; layout shifts and our own writes don't.
		if (!el || Date.now() - userAt.current > 600) return;
		setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
	}

	function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Enter") {
			e.preventDefault();
			go(e.shiftKey ? -1 : 1);
		} else if (e.key === "Escape" && input) {
			e.preventDefault();
			setInput("");
		}
	}

	const touched = () => {
		userAt.current = Date.now();
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: captures Cmd/Ctrl+F for the search field inside
		<div
			className={cn(
				"flex min-h-0 flex-col overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border",
				className,
			)}
			onKeyDown={(e) => {
				if ((e.metaKey || e.ctrlKey) && e.key === "f") {
					e.preventDefault();
					searchRef.current?.focus();
				}
			}}
		>
			<div className="flex flex-wrap items-center gap-2 border-b px-2 py-2 sm:px-3">
				{toolbar}
				<div className="relative flex min-w-0 flex-1 basis-48 items-center">
					<Search
						className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
						aria-hidden
					/>
					<input
						ref={searchRef}
						type="search"
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							setCursor(0);
						}}
						onKeyDown={onSearchKey}
						placeholder="Search output"
						aria-label="Search output"
						className="h-8 w-full min-w-0 rounded-lg bg-muted/60 pr-24 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring dark:bg-muted/40 [&::-webkit-search-cancel-button]:hidden"
					/>
					{query && (
						<div className="absolute right-1 flex items-center gap-0.5">
							<span
								className="px-1 text-xs text-muted-foreground tabular"
								aria-live="polite"
							>
								{matches.length ? `${current + 1}/${matches.length}` : "0/0"}
							</span>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Previous match"
								disabled={!matches.length}
								onClick={() => go(-1)}
							>
								<ChevronUp />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Next match"
								disabled={!matches.length}
								onClick={() => go(1)}
							>
								<ChevronDown />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Clear search"
								onClick={() => setInput("")}
							>
								<X />
							</Button>
						</div>
					)}
				</div>
				<Button
					variant={follow ? "secondary" : "ghost"}
					size="sm"
					aria-pressed={follow}
					onClick={() => setFollow((f) => !f)}
					title="Keep the newest line in view"
				>
					<ArrowDown />
					Follow
				</Button>
				<CopyButton
					value={() => lines.map((l) => l.plain).join("\n")}
					label="Copy all output"
				/>
			</div>

			<div className="relative min-h-0 flex-1">
				<div
					ref={scrollRef}
					onScroll={onScroll}
					onWheel={touched}
					onTouchMove={touched}
					onPointerDown={touched}
					onKeyDown={touched}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls by keyboard
					tabIndex={0}
					role="log"
					aria-label="Output"
					aria-live="off"
					className="absolute inset-0 overflow-auto bg-[var(--log-bg)] py-2 font-mono text-xs leading-5 text-[var(--log-fg)] outline-none [font-size-adjust:0.47] selection:bg-[var(--log-selection)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				>
					{lines.length === 0 ? (
						<p className="px-4 py-2 font-sans text-sm text-[var(--log-muted)] [font-size-adjust:none]">
							{live ? (
								<span className="t-skel">Waiting for output…</span>
							) : (
								empty
							)}
						</p>
					) : (
						<div className="relative w-full" style={{ height: total }}>
							{v.getVirtualItems().map((item) => {
								const line = lines[item.index] as LogLine;
								return (
									<div
										key={item.key}
										ref={v.measureElement}
										data-index={item.index}
										className="absolute top-0 left-0 w-full"
										style={{ transform: `translateY(${item.start}px)` }}
									>
										<Row
											line={line}
											number={item.index + 1}
											query={query}
											current={matches[current] === item.index}
											showSlot={showSlot}
											tag={
												tags && line.tag
													? {
															color: tags.get(line.tag) ?? "inherit",
															width: tagWidth,
														}
													: undefined
											}
										/>
									</div>
								);
							})}
						</div>
					)}
				</div>
				{!follow && live && lines.length > 0 && (
					<Button
						size="sm"
						variant="secondary"
						className="t-reveal absolute right-3 bottom-3 shadow-float"
						onClick={() => setFollow(true)}
					>
						<ArrowDown />
						Jump to latest
					</Button>
				)}
			</div>
			<div className="flex items-center justify-between gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
				<span className="min-w-0 truncate">{status}</span>
				<span className="shrink-0 tabular">
					{lines.length.toLocaleString()}{" "}
					{lines.length === 1 ? "line" : "lines"}
				</span>
			</div>
		</div>
	);
}
