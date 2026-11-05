import { cn } from "@/lib/utils";

/** The organization's logo, or its initial on a tinted square when it has none. */
export function OrgAvatar({
	name,
	logo,
	className,
}: {
	name: string;
	logo: string | null | undefined;
	className?: string;
}) {
	const base = "shrink-0 rounded-md";
	if (logo)
		return (
			<img
				src={logo}
				alt=""
				className={cn(
					base,
					"object-cover outline -outline-offset-1 outline-black/10 dark:outline-white/10",
					className,
				)}
			/>
		);
	return (
		<span
			aria-hidden
			className={cn(
				base,
				"grid place-items-center bg-primary text-sm font-semibold text-primary-foreground",
				className,
			)}
		>
			{name.trim().charAt(0).toUpperCase() || "·"}
		</span>
	);
}
