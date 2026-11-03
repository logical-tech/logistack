import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
	icon: Icon,
	title,
	description,
	children,
	className,
}: {
	icon: LucideIcon;
	title: string;
	description: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"t-reveal flex flex-col items-center rounded-xl bg-muted/60 px-6 py-14 text-center dark:bg-muted/40",
				className,
			)}
		>
			<div className="mb-4 grid size-11 place-items-center rounded-lg bg-card text-muted-foreground shadow-card ring-1 ring-border">
				<Icon className="size-5" strokeWidth={1.75} aria-hidden />
			</div>
			<h2 className="text-md font-semibold">{title}</h2>
			<p className="mt-1.5 max-w-[46ch] text-sm text-muted-foreground">
				{description}
			</p>
			{children && (
				<div className="mt-6 flex flex-wrap items-center justify-center gap-2">
					{children}
				</div>
			)}
		</div>
	);
}
