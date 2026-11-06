import { Dither } from "../dither";
import { SponsorPicker } from "../sponsor-picker";
import { Section } from "../ui";

export function Sponsor() {
	return (
		<Section label="sponsor-title">
			<div
				id="sponsor"
				className="relative isolate overflow-hidden rounded-[28px] bg-surface p-6 sm:p-16 lg:min-h-[560px]"
			>
				<Dither
					shape="spiral"
					cell={8}
					ramp="sponsor"
					gain={1.2}
					seed={5}
					className="absolute top-0 right-0 -z-10 size-[340px] opacity-60 sm:size-[560px] lg:opacity-100"
				/>
				<div className="flex max-w-[640px] flex-col gap-6">
					<h2
						id="sponsor-title"
						className="text-[40px] leading-[1.04] font-medium tracking-[-0.035em] sm:text-[56px]"
					>
						Free, with every feature.
					</h2>
					<p className="text-lg leading-relaxed text-fg/90">
						There is no enterprise edition and no license key. Audit log, SSO,
						custom roles and multi-node are in the same build you install.
						Sponsors pay for the hours behind releases, security fixes and the
						template catalog.
					</p>
					<div className="pt-3">
						<SponsorPicker />
					</div>
				</div>
			</div>
		</Section>
	);
}
