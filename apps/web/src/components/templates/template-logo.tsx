import type { TemplateSummary } from "@logistack/contracts";
import { useState } from "react";
import { api } from "@/lib/api";
import { monogram } from "@/lib/templates";
import { cn } from "@/lib/utils";

/** The template's logo on a light tile, or its initials on a quiet one when it has none. */
export function TemplateLogo({
	template,
	className,
}: {
	template: Pick<TemplateSummary, "id" | "name" | "logo">;
	className?: string;
}) {
	const [failed, setFailed] = useState(false);
	const src =
		template.logo && !failed ? api.templates.logoUrl(template.id) : "";
	return (
		<span
			aria-hidden
			className={cn(
				"grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg",
				src
					? "bg-white p-1.5 outline -outline-offset-1 outline-black/10 dark:outline-white/10"
					: "bg-muted text-xs font-semibold tracking-wide text-muted-foreground",
				className,
			)}
		>
			{src ? (
				<img
					src={src}
					alt=""
					loading="lazy"
					decoding="async"
					onError={() => setFailed(true)}
					className="size-full object-contain"
				/>
			) : (
				monogram(template.name)
			)}
		</span>
	);
}
