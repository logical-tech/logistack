import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const swap =
	"absolute inset-0 m-auto transition-[opacity,scale,filter] duration-(--duration-fast) ease-(--ease-in-out)";

/** Copies `value`; the icon cross-fades to a check for two seconds. */
export function CopyButton({
	value,
	label,
	className,
	variant = "ghost",
	size = "icon-sm",
	children,
}: {
	value: string;
	/** Accessible name and toast text, e.g. "public key". */
	label: string;
	className?: string;
	variant?: "ghost" | "outline" | "secondary" | "default";
	size?: "icon-sm" | "icon" | "sm" | "default";
	children?: React.ReactNode;
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error(`Couldn't copy the ${label}`, {
				description: "Select the text and copy it by hand.",
			});
		}
	}

	return (
		<Button
			type="button"
			variant={variant}
			size={size}
			onClick={copy}
			aria-label={children ? undefined : `Copy ${label}`}
			className={cn("shrink-0", className)}
		>
			<span className="relative grid size-4 place-items-center" aria-hidden>
				<Copy
					className={cn(
						swap,
						"size-4",
						copied ? "scale-25 opacity-0 blur-[4px]" : "scale-100 opacity-100",
					)}
				/>
				<Check
					className={cn(
						swap,
						"size-4 text-ok-text",
						copied ? "scale-100 opacity-100" : "scale-25 opacity-0 blur-[4px]",
					)}
				/>
			</span>
			{children}
			<span className="sr-only" aria-live="polite">
				{copied ? `Copied ${label}` : ""}
			</span>
		</Button>
	);
}
