import { UserRound } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Panel, SkeletonRows } from "@/components/panel";
import { useGrants, useInvitations, useMembers } from "@/lib/api/access";

/**
 * Members page → Guests: people invited to single projects. They hold no organization-wide
 * role (`guest` membership) and one `guest` grant per project.
 */
export function GuestsSection() {
	const members = useMembers();
	const grants = useGrants();
	const invitations = useInvitations();
	const guests = (members.data ?? []).filter((m) => m.role === "guest");
	const pending = (invitations.data ?? []).filter((i) => i.role === "guest");
	const projectsOf = (userId: string) =>
		(grants.data ?? [])
			.filter((g) => g.userId === userId && g.scope.kind === "project")
			.map((g) => g.scopeLabel);

	return (
		<Panel title="Guests">
			{members.isPending || grants.isPending ? (
				<SkeletonRows rows={2} />
			) : guests.length + pending.length === 0 ? (
				<EmptyState
					icon={UserRound}
					title="No guests"
					description="Invite a client to one project from its menu: they read tasks and comment there, and see nothing else."
				/>
			) : (
				<ul className="divide-y rounded-lg ring-1 ring-border">
					{guests.map((g) => {
						const projects = projectsOf(g.userId);
						return (
							<li key={g.id} className="flex items-center gap-3 px-4 py-3">
								<span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium uppercase">
									{g.name.slice(0, 1)}
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm font-medium">
										{g.name}
									</span>
									<span className="block truncate text-sm text-muted-foreground">
										{g.email}
									</span>
								</span>
								<span className="truncate text-right text-sm text-muted-foreground">
									{projects.length ? projects.join(", ") : "No project"}
								</span>
							</li>
						);
					})}
					{pending.map((i) => (
						<li key={i.id} className="flex items-center gap-3 px-4 py-3">
							<span className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground">
								<UserRound className="size-4" aria-hidden />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm">{i.email}</span>
								<span className="block text-sm text-muted-foreground">
									Invited, not accepted yet
								</span>
							</span>
						</li>
					))}
				</ul>
			)}
		</Panel>
	);
}
