import { aiProvider } from "@logistack/core/ai-providers";
import { ArrowUpRight } from "lucide-react";
import { formatAllowances } from "@/components/ai/parts";
import { Panel } from "@/components/panel";
import type { AiSettings } from "@/lib/api/ai";

/** Where to sign up for every provider not connected yet, so people can collect keys up front. */
export function SignupLinks({
	settings,
	connected,
}: {
	settings: AiSettings;
	connected: Set<string>;
}) {
	const open = settings.providers.filter(
		(p) => p.keyUrl && !connected.has(p.id),
	);
	if (!open.length) return null;
	return (
		<div className="grid gap-10">
			{(["free", "paid"] as const).map((tier) => {
				const list = open.filter((p) => p.tier === tier);
				if (!list.length) return null;
				return (
					<Panel
						key={tier}
						id={`signup-${tier}`}
						title={tier === "free" ? "Get free API keys" : "Get paid API keys"}
					>
						<ul className="grid divide-y sm:grid-cols-2 sm:divide-y-0">
							{list.map((p) => (
								<li key={p.id} className="sm:border-b sm:odd:border-r">
									<a
										href={p.keyUrl ?? undefined}
										target="_blank"
										rel="noopener noreferrer"
										className="group flex items-center gap-3 px-4 py-3 outline-none transition-colors duration-(--duration-quick) hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
									>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-sm font-medium">
												{p.name}
											</span>
											<span className="block truncate text-xs text-muted-foreground">
												{tier === "free"
													? p.keyless
														? "No key needed · sign up for higher limits"
														: formatAllowances(
																aiProvider(p.id)?.freeQuota?.limits,
															)
													: "Billed by the provider"}
											</span>
										</span>
										<span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground group-hover:text-foreground">
											Sign up
											<ArrowUpRight className="size-3.5" aria-hidden />
										</span>
										<span className="sr-only">(opens in a new tab)</span>
									</a>
								</li>
							))}
						</ul>
					</Panel>
				);
			})}
		</div>
	);
}
