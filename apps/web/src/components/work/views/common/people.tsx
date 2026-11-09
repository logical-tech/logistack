import type { WorkPerson } from "@logistack/contracts";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

const initials = (name: string) =>
	name
		.split(/\s+/)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase() ?? "")
		.join("");

/** Overlapping assignee avatars, at most `max` plus a count. */
export function AvatarStack({
	ids,
	people,
	max = 3,
	size = "sm",
	className,
}: {
	ids: readonly string[];
	people: ReadonlyMap<string, WorkPerson>;
	max?: number;
	size?: "xs" | "sm";
	className?: string;
}) {
	if (!ids.length) return null;
	const shown = ids.slice(0, max);
	const names = ids.map((id) => people.get(id)?.name ?? "Former member");
	const dim =
		size === "xs" ? "size-4 text-[0.5rem]" : "size-5 text-[0.5625rem]";
	return (
		<span
			role="img"
			aria-label={names.join(", ")}
			title={names.join(", ")}
			className={cn("flex shrink-0 items-center -space-x-1.5", className)}
		>
			{shown.map((id) => {
				const p = people.get(id);
				return (
					<Avatar key={id} className={cn(dim, "ring-2 ring-card after:hidden")}>
						{p?.avatar && <AvatarImage src={p.avatar} alt="" />}
						<AvatarFallback className="bg-secondary font-semibold text-secondary-foreground">
							{initials(p?.name ?? "?")}
						</AvatarFallback>
					</Avatar>
				);
			})}
			{ids.length > max && (
				<span
					className={cn(
						dim,
						"grid place-items-center rounded-full bg-muted font-semibold text-muted-foreground tabular ring-2 ring-card",
					)}
				>
					+{ids.length - max}
				</span>
			)}
		</span>
	);
}
