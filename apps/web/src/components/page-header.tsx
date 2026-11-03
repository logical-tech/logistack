import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
	title,
	description,
	actions,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<header
			className={cn(
				"flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between",
				className,
			)}
		>
			<div className="min-w-0">
				<h1 className="text-xl font-semibold">{title}</h1>
				{description && (
					<p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
						{description}
					</p>
				)}
			</div>
			{actions && (
				<div className="flex shrink-0 items-center gap-2">{actions}</div>
			)}
		</header>
	);
}

export function Page({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"mx-auto w-full max-w-6xl px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-8",
				className,
			)}
		>
			{children}
		</div>
	);
}
