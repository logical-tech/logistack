import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ICON =
	"transition-[scale,opacity,filter] duration-(--duration-fast) ease-[cubic-bezier(0.2,0,0,1)]";
const HIDDEN = "scale-25 opacity-0 blur-[4px]";

/** Copies `value`; the icon cross-fades to a check for 1.5 s. */
export function CopyButton({
	value,
	label,
	className,
}: {
	/** A function is called on click, for values too large to build every render. */
	value: string | (() => string);
	label: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(t);
	}, [copied]);
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-label={copied ? "Copied" : label}
			className={cn("relative text-muted-foreground", className)}
			onClick={() =>
				navigator.clipboard
					.writeText(typeof value === "function" ? value() : value)
					.then(
						() => setCopied(true),
						() =>
							toast.error("Couldn't copy", {
								description: "The browser blocked clipboard access.",
							}),
					)
			}
		>
			<Copy className={cn(ICON, copied && HIDDEN)} aria-hidden />
			<Check
				className={cn(ICON, "absolute text-ok-text", !copied && HIDDEN)}
				aria-hidden
			/>
		</Button>
	);
}

/** A value to paste elsewhere (URL, public key, command), with its copy button. */
export function CopyField({
	value,
	label,
	wrap,
	className,
}: {
	value: string;
	label: string;
	/** Break long values over lines instead of truncating (public keys). */
	wrap?: boolean;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-w-0 items-start gap-1 rounded-lg bg-muted/60 py-1 pr-1 pl-3 dark:bg-muted/40",
				className,
			)}
		>
			<code
				className={cn(
					"min-w-0 flex-1 py-1 font-mono text-xs leading-5",
					wrap ? "break-all" : "truncate",
				)}
				title={wrap ? undefined : value}
			>
				{value}
			</code>
			<CopyButton value={value} label={label} />
		</div>
	);
}
