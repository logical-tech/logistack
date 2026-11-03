import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function Field({
	id,
	label,
	hint,
	error,
	optional,
	children,
	className,
}: {
	id: string;
	label: string;
	hint?: ReactNode;
	error?: string;
	optional?: boolean;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("grid content-start gap-2", className)}>
			<Label htmlFor={id} className="text-sm">
				{label}
				{optional && (
					<span className="font-normal text-muted-foreground">Optional</span>
				)}
			</Label>
			{children}
			<p
				id={`${id}-msg`}
				className={cn(
					"text-xs",
					error ? "text-bad-text" : "text-muted-foreground",
					!error && !hint && "sr-only",
				)}
				aria-live="polite"
			>
				{error ?? hint}
			</p>
		</div>
	);
}
