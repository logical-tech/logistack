import { Dither } from "../dither";
import { Section } from "../ui";

const steps = [
	["Import", "Projects, env vars and domains, checked before anything changes"],
	["Cut over", "One service at a time, both platforms on the same network"],
	["Roll back", "Any single service, until you switch the old setup off"],
] as const;

export function Migrate() {
	return (
		<Section label="migrate-title">
			<div className="grid items-center gap-12 lg:grid-cols-[520px_1fr] lg:gap-20">
				<div className="flex flex-col gap-6">
					<h2
						id="migrate-title"
						className="text-[40px] leading-[1.04] font-medium tracking-[-0.035em] sm:text-[56px]"
					>
						Move over one service at a time.
					</h2>
					<p className="text-lg leading-relaxed text-fg/90">
						Already running another self-hosted PaaS? The importer reads its
						projects, env vars and domains. It freezes the old setup, then moves
						services across when you say so. The old platform keeps serving
						until you switch it off.
					</p>
					<ol className="flex flex-col gap-3 pt-2">
						{steps.map(([name, what]) => (
							<li
								key={name}
								className="flex gap-4 rounded-[14px] bg-step px-[18px] py-3.5 text-[15px]"
							>
								<span className="w-[90px] shrink-0 font-semibold">{name}</span>
								<span className="text-muted">{what}</span>
							</li>
						))}
					</ol>
				</div>
				<figure
					data-ui
					aria-label="Services moving from the old platform to LogiStack"
					className="relative h-[360px] overflow-hidden rounded-[28px] bg-deep sm:h-[520px]"
				>
					<Dither
						shape="bridge"
						cell={8}
						ramp="bridge"
						gain={1.15}
						seed={33}
						className="absolute inset-x-5 top-[60px] h-[calc(100%-160px)] w-[calc(100%-40px)]"
					/>
					<figcaption className="absolute inset-x-10 bottom-10 flex justify-between">
						<span className="flex flex-col">
							<span className="text-[15px] font-semibold">Old platform</span>
							<span className="text-[13px] text-muted">
								frozen, still serving
							</span>
						</span>
						<span className="flex flex-col text-right">
							<span className="text-[15px] font-semibold">LogiStack</span>
							<span className="text-[13px] text-muted">
								4 of 7 services moved
							</span>
						</span>
					</figcaption>
				</figure>
			</div>
		</Section>
	);
}
