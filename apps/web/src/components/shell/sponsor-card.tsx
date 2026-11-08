import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Heart, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { SPONSOR_URL, sponsorQuery, useIsSponsor } from "@/lib/api/sponsor";
import { updateStatusQuery } from "@/lib/api/updates";
import { useSponsorGlow } from "@/lib/sponsor-glow";

const DISMISS_KEY = "ls-sponsor-card-hidden-until";
const HIDE_FOR = 30 * 86_400_000;

function hiddenUntil(): number {
	try {
		return Number(localStorage.getItem(DISMISS_KEY)) || 0;
	} catch {
		return 0;
	}
}

/**
 * A quiet ask above the sidebar footer. Never for sponsors, never while an update card is
 * showing (one card at a time), and gone for 30 days once closed.
 */
export function SponsorCard() {
	const { loaded, sponsor } = useIsSponsor();
	const { data: update } = useQuery(updateStatusQuery);
	const { state, isMobile } = useSidebar();
	const [hidden, setHidden] = useState(() => hiddenUntil() > Date.now());

	const updateShowing = !!update?.updateAvailable || !!update?.run;
	if (!loaded || sponsor || hidden || updateShowing) return null;
	if (state === "collapsed" && !isMobile) return null;

	const dismiss = () => {
		try {
			localStorage.setItem(DISMISS_KEY, String(Date.now() + HIDE_FOR));
		} catch {}
		setHidden(true);
	};

	return (
		<div className="t-reveal relative mx-2 mb-1 rounded-lg bg-sidebar-accent/60 p-3 ring-1 ring-sidebar-border">
			<p className="flex items-center gap-2 pr-6 text-sm font-medium">
				<Heart
					className="size-3.5 shrink-0 text-primary"
					strokeWidth={2}
					aria-hidden
				/>
				Keep LogiStack free
			</p>
			<p className="mt-1 text-xs text-pretty text-muted-foreground">
				Every feature ships to everyone. Sponsors pay for releases and security
				fixes.
			</p>
			<div className="mt-2.5 flex items-center gap-2">
				<Button size="sm" className="h-7" asChild>
					<a href={SPONSOR_URL} target="_blank" rel="noreferrer">
						Sponsor
						<ArrowUpRight className="size-3.5" aria-hidden />
					</a>
				</Button>
				<Button variant="ghost" size="sm" className="h-7 px-2" asChild>
					<Link to="/settings/sponsor">I have a key</Link>
				</Button>
			</div>
			<button
				type="button"
				onClick={dismiss}
				aria-label="Hide for 30 days"
				title="Hide for 30 days"
				className="t-press absolute top-2 right-2 grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-[background-color,color] duration-(--duration-quick) after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
			>
				<X className="size-3.5" aria-hidden />
			</button>
		</div>
	);
}

/**
 * A thank-you for sponsors: a faint rose light rising from the bottom-left corner.
 * Sits above the shell but below overlays, never takes pointer events.
 */
export function SponsorGlow() {
	const { sponsor } = useIsSponsor();
	const on = useSponsorGlow();
	if (!sponsor || !on) return null;
	return <div aria-hidden className="sponsor-glow" />;
}

/** The sponsor mark in the sidebar footer, beside the version. */
export function SponsorBadge() {
	const { data } = useQuery(sponsorQuery);
	if (data?.state !== "active") return null;
	const until = data.expiresAt
		? new Date(data.expiresAt).toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
			})
		: null;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Link
					to="/settings/sponsor"
					className="t-press inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 text-2xs font-medium text-primary outline-none ring-1 ring-primary/20 transition-[background-color] duration-(--duration-quick) hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:hidden"
				>
					<Heart className="size-3 fill-current" aria-hidden />
					{data.sandbox ? "Sandbox" : "Sponsor"}
				</Link>
			</TooltipTrigger>
			<TooltipContent side="top">
				{data.kind === "monthly"
					? `Monthly sponsor${until ? `, renews before ${until}` : ""}`
					: `Sponsor${until ? ` until ${until}` : ""}`}
			</TooltipContent>
		</Tooltip>
	);
}
