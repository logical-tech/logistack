import { Link } from "@tanstack/react-router";
import { ArrowRight, LayoutTemplate } from "lucide-react";
import type { EnvironmentId, ProjectId } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/** The New service wizard's way into the template gallery; a link, so arrowing through the sources never leaves the page. */
export function TemplatesTile({
	projectId,
	environmentId,
}: {
	projectId: ProjectId;
	environmentId: EnvironmentId;
}) {
	return (
		<Link
			to="/projects/$projectId/templates"
			params={{ projectId }}
			search={{ env: environmentId }}
			className={cn(
				"group flex items-center gap-3 rounded-lg bg-card p-3.5 text-left ring-1 ring-border outline-none t-press",
				"hover:ring-foreground/25 focus-visible:ring-2 focus-visible:ring-ring",
			)}
		>
			<span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground">
				<LayoutTemplate className="size-4" strokeWidth={1.75} aria-hidden />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-medium">Templates</span>
				<span className="mt-0.5 block text-xs text-muted-foreground">
					Over 500 ready-made apps, deployed with their databases and secrets in
					one step.
				</span>
			</span>
			<ArrowRight
				className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-quick) ease-(--ease-smooth-out) group-hover:translate-x-0.5"
				aria-hidden
			/>
		</Link>
	);
}
