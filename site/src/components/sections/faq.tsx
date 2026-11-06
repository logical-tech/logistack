import { faq } from "@/content/faq";
import { Section } from "../ui";

export function Faq() {
	return (
		<Section label="faq-title">
			<div id="faq" className="grid gap-10 lg:grid-cols-[440px_1fr] lg:gap-20">
				<h2
					id="faq-title"
					className="text-[40px] leading-[1.04] font-medium tracking-[-0.035em] sm:text-[56px]"
				>
					Questions people ask first.
				</h2>
				<div className="flex flex-col gap-2">
					{faq.map(({ q, a }) => (
						<details
							key={q}
							className="group rounded-[18px] bg-step px-6 py-5 open:bg-surface"
						>
							<summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-lg font-medium [&::-webkit-details-marker]:hidden">
								{q}
								<svg
									viewBox="0 0 24 24"
									aria-hidden
									className="size-5 shrink-0 text-muted transition-transform duration-200 group-open:rotate-45"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
								>
									<path d="M12 5v14M5 12h14" />
								</svg>
							</summary>
							<p className="mt-3 max-w-[64ch] text-base leading-relaxed text-muted">
								{a}
							</p>
						</details>
					))}
				</div>
			</div>
		</Section>
	);
}
