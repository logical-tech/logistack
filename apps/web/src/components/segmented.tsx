import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A small set of mutually exclusive view options. Arrow keys move, the pressed one is filled. */
export function Segmented<T extends string>({
	value,
	onChange,
	options,
	label,
}: {
	value: T;
	onChange: (v: T) => void;
	options: { value: T; label: ReactNode; ariaLabel?: string }[];
	label: string;
}) {
	return (
		<ToggleGroupPrimitive.Root
			type="single"
			value={value}
			onValueChange={(v) => v && onChange(v as T)}
			aria-label={label}
			className="inline-flex rounded-lg bg-muted p-0.5 dark:bg-muted/60"
		>
			{options.map((o) => (
				<ToggleGroupPrimitive.Item
					key={o.value}
					value={o.value}
					aria-label={o.ariaLabel}
					className={cn(
						"inline-flex h-7 min-w-10 items-center justify-center gap-1.5 rounded-md px-2.5 whitespace-nowrap text-xs font-medium text-muted-foreground tabular outline-none transition-[color,background-color,box-shadow] duration-(--duration-quick)",
						"hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
						"data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-card data-[state=on]:ring-1 data-[state=on]:ring-border",
					)}
				>
					{o.label}
				</ToggleGroupPrimitive.Item>
			))}
		</ToggleGroupPrimitive.Root>
	);
}
