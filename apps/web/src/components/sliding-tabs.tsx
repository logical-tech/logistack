import {
	type KeyboardEvent,
	type ReactNode,
	useLayoutEffect,
	useRef,
} from "react";
import { cn } from "@/lib/utils";

export type TabItem<T extends string> = { id: T; label: ReactNode };

/**
 * Underline tabs whose indicator slides to the active tab (transitions-dev
 * "tabs sliding"). Positions are written without a transition on first paint
 * and on resize, so the indicator never animates in from the left edge.
 */
export function SlidingTabs<T extends string>({
	items,
	value,
	onChange,
	label,
	idPrefix,
}: {
	items: TabItem<T>[];
	value: T;
	onChange: (id: T) => void;
	label: string;
	idPrefix: string;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const pillRef = useRef<HTMLSpanElement>(null);
	const painted = useRef(false);

	useLayoutEffect(() => {
		const list = listRef.current;
		const pill = pillRef.current;
		if (!list || !pill) return;
		const place = (animate: boolean) => {
			const tab = list.querySelector<HTMLElement>(`[data-tab="${value}"]`);
			if (!tab) return;
			if (!animate) pill.style.transition = "none";
			pill.style.transform = `translateX(${tab.offsetLeft}px)`;
			pill.style.width = `${tab.offsetWidth}px`;
			if (!animate) {
				void pill.offsetWidth;
				pill.style.transition = "";
			}
		};
		place(painted.current);
		painted.current = true;
		// A list wider than the screen scrolls; keep the active tab in it.
		const tab = list.querySelector<HTMLElement>(`[data-tab="${value}"]`);
		if (tab)
			list.scrollLeft = Math.max(
				0,
				tab.offsetLeft + tab.offsetWidth / 2 - list.clientWidth / 2,
			);
		const ro = new ResizeObserver(() => place(false));
		ro.observe(list);
		for (const tab of list.querySelectorAll("[role=tab]")) ro.observe(tab);
		return () => ro.disconnect();
	}, [value]);

	function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		const i = items.findIndex((t) => t.id === value);
		const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
		if (!delta) return;
		e.preventDefault();
		const next = items[(i + delta + items.length) % items.length];
		if (!next) return;
		onChange(next.id);
		listRef.current
			?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)
			?.focus();
	}

	return (
		<div
			ref={listRef}
			role="tablist"
			aria-label={label}
			onKeyDown={onKeyDown}
			className="no-scrollbar relative -mb-px flex gap-1 overflow-x-auto"
		>
			{items.map((t) => {
				const selected = t.id === value;
				return (
					<button
						key={t.id}
						type="button"
						role="tab"
						id={`${idPrefix}-tab-${t.id}`}
						aria-controls={`${idPrefix}-panel`}
						aria-selected={selected}
						tabIndex={selected ? 0 : -1}
						data-tab={t.id}
						onClick={() => onChange(t.id)}
						className={cn(
							"relative flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap transition-colors duration-(--duration-fast) outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
							selected
								? "text-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{t.label}
					</button>
				);
			})}
			<span
				ref={pillRef}
				aria-hidden
				className="pointer-events-none absolute bottom-0 left-0 h-0.5 w-0 rounded-full bg-foreground transition-[transform,width] duration-(--duration-fast) ease-(--ease-smooth-out) motion-reduce:transition-none"
			/>
		</div>
	);
}
