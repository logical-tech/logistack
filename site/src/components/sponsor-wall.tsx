"use client";

import { useEffect, useState } from "react";
import { sponsorsApi } from "@/content/sponsor";

type Sponsor = {
	name: string;
	website: string | null;
	kind: "monthly" | "once";
};

/**
 * Sponsors who left a name at checkout, read live from the sponsors Worker so the static
 * site needs no rebuild. Monthly sponsors first, each group oldest first. Hidden while empty.
 */
export function SponsorWall() {
	const [sponsors, setSponsors] = useState<Sponsor[]>([]);

	useEffect(() => {
		fetch(`${sponsorsApi}/v1/sponsors`)
			.then((r) => (r.ok ? r.json() : { sponsors: [] }))
			.then((d: { sponsors: Sponsor[] }) =>
				setSponsors(
					[...d.sponsors].sort(
						(a, b) =>
							Number(b.kind === "monthly") - Number(a.kind === "monthly"),
					),
				),
			)
			.catch(() => {});
	}, []);

	if (!sponsors.length) return null;
	return (
		<div className="flex flex-col gap-4 pt-6">
			<h3 className="text-[15px] font-medium text-muted">
				Thank you to our sponsors
			</h3>
			<ul className="flex flex-wrap gap-2">
				{sponsors.map((s) => (
					<li key={`${s.kind}-${s.name}-${s.website}`}>
						{s.website ? (
							<a
								href={s.website}
								rel="sponsored nofollow noopener"
								target="_blank"
								className="pressable inline-flex h-10 items-center rounded-full bg-tile px-4 text-[15px] font-medium hover:bg-raised"
							>
								{s.name}
							</a>
						) : (
							<span className="inline-flex h-10 items-center rounded-full bg-tile px-4 text-[15px] font-medium">
								{s.name}
							</span>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
