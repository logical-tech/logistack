import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpCircle, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { meQuery } from "@/lib/api/access";
import { isActive, useStartUpdate, useUpdateStatus } from "@/lib/api/updates";

const tag = (v: string) => (/^\d/.test(v) ? `v${v}` : v);

/**
 * Shows above the sidebar footer only while a newer release exists or an update runs. Admins
 * start it from here; everyone else gets a link to the release notes.
 */
export function UpdateBadge() {
	const { data: s } = useUpdateStatus();
	const { data: me } = useQuery(meQuery);
	const admin = !!me?.roles.some((r) => r === "owner" || r === "admin");
	const start = useStartUpdate();
	const navigate = useNavigate();
	const { state, isMobile } = useSidebar();
	const collapsed = state === "collapsed" && !isMobile;
	const [confirming, setConfirming] = useState(false);

	const running = isActive(s?.run);
	const target = s?.latest && s.updateAvailable ? s.latest : null;
	if (!running && !target) return null;

	const label = running
		? `Updating to ${tag(s?.run?.toVersion ?? "")}`
		: `${tag(target?.version ?? "")} available`;

	if (collapsed)
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<Link
						to="/settings/updates"
						aria-label={label}
						className="t-press relative mx-auto grid size-8 place-items-center rounded-md text-foreground outline-none transition-[background-color] duration-(--duration-quick) hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
					>
						{running ? (
							<Loader2 className="size-4 animate-spin" aria-hidden />
						) : (
							<>
								<ArrowUpCircle
									className="size-4"
									strokeWidth={1.75}
									aria-hidden
								/>
								<span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary" />
							</>
						)}
					</Link>
				</TooltipTrigger>
				<TooltipContent side="right">{label}</TooltipContent>
			</Tooltip>
		);

	return (
		<div className="t-reveal mx-2 mb-1 rounded-lg bg-sidebar-accent/60 p-3 ring-1 ring-sidebar-border">
			<p className="flex items-center gap-2 text-sm font-medium">
				{running ? (
					<Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
				) : (
					<span
						className="size-1.5 shrink-0 rounded-full bg-primary"
						aria-hidden
					/>
				)}
				<span className="truncate tabular">{label}</span>
			</p>
			<p className="mt-1 text-xs text-muted-foreground">
				{running
					? "The dashboard may blink while the API restarts."
					: `You run ${tag(s?.current.version ?? "")}.`}
			</p>
			<div className="mt-2.5 flex items-center gap-2">
				{target && admin && !running && (
					<Button size="sm" className="h-7" onClick={() => setConfirming(true)}>
						Update
					</Button>
				)}
				<Button variant="ghost" size="sm" className="h-7 px-2" asChild>
					<Link to="/settings/updates">
						{running ? "Follow progress" : "What's new"}
					</Link>
				</Button>
			</div>
			{target && (
				<ConfirmDialog
					open={confirming}
					onOpenChange={setConfirming}
					title={`Update to ${tag(target.version)}?`}
					description="LogiStack pulls every image first and changes nothing if one is missing. A service that doesn't turn healthy rolls back, and so does every service updated before it."
					confirmLabel={`Update to ${tag(target.version)}`}
					destructive={false}
					pending={start.isPending}
					onConfirm={() =>
						start.mutate(target.version, {
							onSuccess: () => {
								setConfirming(false);
								void navigate({ to: "/settings/updates" });
							},
							onError: (err) => {
								setConfirming(false);
								toast.error("The update didn't start", {
									description: err.message,
								});
							},
						})
					}
				/>
			)}
		</div>
	);
}
