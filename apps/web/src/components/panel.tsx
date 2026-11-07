import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
	title,
	actions,
	children,
	className,
	bodyClassName,
	id,
}: {
	title: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
	id?: string;
}) {
	return (
		<section aria-labelledby={id} className={cn("min-w-0", className)}>
			<div className="mb-2.5 flex min-h-7 items-center justify-between gap-3">
				<h2
					id={id}
					className="scroll-mt-20 text-sm font-semibold [font-stretch:100%]"
				>
					{title}
				</h2>
				{actions}
			</div>
			<div
				className={cn(
					"overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border",
					bodyClassName,
				)}
			>
				{children}
			</div>
		</section>
	);
}

/** Placeholder rows that pulse in the slot the content will take. */
export function SkeletonRows({
	rows = 4,
	className,
}: {
	rows?: number;
	className?: string;
}) {
	return (
		<div className={cn("divide-y", className)} aria-hidden>
			{Array.from({ length: rows }, (_, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
					key={i}
					className="flex h-12 items-center gap-3 px-4"
				>
					<span className="t-skel size-2 rounded-full bg-muted-foreground/20" />
					<span
						className="t-skel h-3 rounded bg-muted-foreground/15"
						style={{ width: `${38 + ((i * 17) % 34)}%` }}
					/>
					<span className="t-skel ml-auto h-3 w-12 rounded bg-muted-foreground/10" />
				</div>
			))}
		</div>
	);
}
