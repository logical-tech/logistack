import type { Environment, EnvironmentColor } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export const ENV_COLORS: Record<
	EnvironmentColor,
	{ label: string; dot: string }
> = {
	gray: { label: "Gray", dot: "bg-zinc-400 dark:bg-zinc-500" },
	blue: { label: "Blue", dot: "bg-blue-500 dark:bg-blue-400" },
	green: { label: "Green", dot: "bg-emerald-500 dark:bg-emerald-400" },
	amber: { label: "Amber", dot: "bg-amber-500 dark:bg-amber-400" },
	red: { label: "Red", dot: "bg-rose-500 dark:bg-rose-400" },
	violet: { label: "Violet", dot: "bg-violet-500 dark:bg-violet-400" },
};

/** Unset colors follow the kind, so production and staging differ before anyone picks. */
const KIND_COLOR: Record<Environment["kind"], EnvironmentColor> = {
	production: "violet",
	staging: "amber",
	preview: "blue",
	custom: "gray",
};

export const envColor = (e: Pick<Environment, "color" | "kind">) =>
	e.color ?? KIND_COLOR[e.kind];

/** A rounded square, so it never reads as a status dot beside the round ones. */
export function EnvDot({
	env,
	className,
}: {
	env: Pick<Environment, "color" | "kind">;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"inline-block size-2 shrink-0 rounded-[2px]",
				ENV_COLORS[envColor(env)].dot,
				className,
			)}
		/>
	);
}
