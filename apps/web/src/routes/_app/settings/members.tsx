import { createFileRoute } from "@tanstack/react-router";
import {
	CircleAlert,
	MoreHorizontal,
	ShieldCheck,
	ShieldOff,
	ShieldPlus,
	UserPlus,
	Users,
	X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/access/confirm-dialog";
import { CopyButton } from "@/components/access/copy-button";
import {
	AddAccessDialog,
	grantPhrase,
	InviteDialog,
	isOrgAdmin,
	roleName,
} from "@/components/access/members-dialogs";
import { RoleSelect } from "@/components/access/scope-picker";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	useCancelInvitation,
	useGrants,
	useInvitations,
	useMe,
	useMembers,
	useRemoveGrant,
	useRemoveMember,
	useSetMemberRole,
	useTwoFactorSetting,
} from "@/lib/api/access";
import type { Member, RoleGrant } from "@/lib/api/access-types";
import { daysUntil, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings/members")({
	staticData: { crumb: "Members" },
	component: Members,
});

const initials = (name: string) =>
	name
		.split(/\s+/)
		.map((p) => p[0])
		.slice(0, 2)
		.join("")
		.toUpperCase();

function Members() {
	const { data: me } = useMe();
	const members = useMembers();
	const grants = useGrants();
	const invitations = useInvitations();
	const admin = isOrgAdmin(me);
	const [inviting, setInviting] = useState(false);
	const [granting, setGranting] = useState<Member | null>(null);
	const [removing, setRemoving] = useState<Member | null>(null);
	const remove = useRemoveMember();

	const people = members.data ?? [];
	const pending = invitations.data ?? [];

	return (
		<Page>
			<PageHeader
				title="Members"
				description="People with access to this organization. A role here applies everywhere; add access to grant more on one folder, project, environment or service."
				actions={
					admin && (
						<Button onClick={() => setInviting(true)}>
							<UserPlus data-icon="inline-start" />
							Invite member
						</Button>
					)
				}
			/>

			<div className="grid gap-10">
				<Panel
					title={
						<>
							People{" "}
							{members.data && (
								<span className="font-normal text-muted-foreground tabular-nums">
									{people.length}
								</span>
							)}
						</>
					}
					id="people"
				>
					{members.isPending ? (
						<SkeletonRows rows={5} />
					) : members.isError ? (
						<LoadError
							message={members.error.message}
							retry={() => members.refetch()}
						/>
					) : people.length === 0 ? (
						<EmptyState
							icon={Users}
							title="Only you so far"
							description="Invite teammates by email and grant them a role on the whole organization or on a single folder or project."
							className="rounded-none"
						/>
					) : (
						<ul className="divide-y">
							{people.map((m) => (
								<MemberRow
									key={m.id}
									member={m}
									grants={(grants.data ?? []).filter(
										(g) => g.userId === m.userId,
									)}
									isSelf={me?.userId === m.userId}
									admin={admin}
									onAddAccess={() => setGranting(m)}
									onRemove={() => setRemoving(m)}
								/>
							))}
						</ul>
					)}
				</Panel>

				{admin && pending.length > 0 && (
					<Panel
						title={
							<>
								Pending invitations{" "}
								<span className="font-normal text-muted-foreground tabular-nums">
									{pending.length}
								</span>
							</>
						}
						id="invitations"
					>
						<ul className="divide-y">
							{pending.map((inv) => (
								<InvitationRow key={inv.id} invitation={inv} />
							))}
						</ul>
					</Panel>
				)}
			</div>

			<InviteDialog open={inviting} onOpenChange={setInviting} />
			<AddAccessDialog
				member={granting}
				organizationId={me?.organizationId ?? ""}
				onOpenChange={(open) => !open && setGranting(null)}
			/>
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
				title={`Remove ${removing?.name ?? ""}?`}
				description="They lose access to every project at once, along with their scoped grants. Their API keys stop working. You can invite them again later."
				confirmLabel="Remove member"
				onConfirm={() =>
					remove
						.mutateAsync(removing?.id ?? "")
						.then(() => toast.success(`${removing?.name} removed`))
						.catch((err: Error) => {
							toast.error("Couldn't remove the member", {
								description: err.message,
							});
							throw err;
						})
				}
			/>
		</Page>
	);
}

function LoadError({ message, retry }: { message: string; retry: () => void }) {
	return (
		<div
			role="alert"
			className="flex flex-wrap items-center gap-3 px-4 py-6 text-sm"
		>
			<CircleAlert className="size-4 text-bad-text" aria-hidden />
			<span className="min-w-0 flex-1">
				Couldn't load members.{" "}
				<span className="text-muted-foreground">{message}</span>
			</span>
			<Button variant="outline" size="sm" onClick={retry}>
				Try again
			</Button>
		</div>
	);
}

function MemberRow({
	member: m,
	grants,
	isSelf,
	admin,
	onAddAccess,
	onRemove,
}: {
	member: Member;
	grants: RoleGrant[];
	isSelf: boolean;
	admin: boolean;
	onAddAccess: () => void;
	onRemove: () => void;
}) {
	const setRole = useSetMemberRole();
	const removeGrant = useRemoveGrant();
	const required = useTwoFactorSetting().data?.mode === "required";

	function changeRole(role: string) {
		setRole.mutate(
			{ id: m.id, role },
			{
				onSuccess: () => toast.success(`${m.name} is now ${roleName(role)}`),
				onError: (err) =>
					toast.error("Couldn't change the role", {
						description: err.message,
					}),
			},
		);
	}

	function revoke(g: RoleGrant) {
		const phrase = grantPhrase(g.role, g.scope, g.scopeLabel);
		removeGrant.mutate(g.id, {
			onSuccess: () => toast.success(`${m.name} is no longer ${phrase}`),
			onError: (err) =>
				toast.error("Couldn't remove that access", {
					description: err.message,
				}),
		});
	}

	return (
		<li className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-2.5 px-4 py-3.5 md:grid-cols-[auto_minmax(0,1fr)_9.5rem_7.5rem_2rem] md:items-center">
			<span
				className="grid size-9 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
				aria-hidden
			>
				{initials(m.name)}
			</span>
			<div className="min-w-0">
				<p className="flex min-w-0 items-center gap-2 text-sm font-medium">
					<span className="truncate">{m.name}</span>
					{isSelf && (
						<span className="shrink-0 text-xs font-normal text-muted-foreground">
							You
						</span>
					)}
				</p>
				<p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
					<span className="truncate">{m.email}</span>
					<span aria-hidden>·</span>
					{m.twoFactorEnabled || m.passkey ? (
						<span className="inline-flex shrink-0 items-center gap-1 text-ok-text">
							<ShieldCheck className="size-3.5" aria-hidden />
							{m.twoFactorEnabled ? "2FA" : "Passkey"}
						</span>
					) : (
						<span
							className={cn(
								"inline-flex shrink-0 items-center gap-1",
								required && "text-warn-text",
							)}
						>
							<ShieldOff className="size-3.5" aria-hidden />
							{required ? "No 2FA, required" : "No 2FA"}
						</span>
					)}
				</p>
				{grants.length > 0 && (
					<ul
						className="mt-2 flex flex-wrap gap-1.5"
						aria-label="Scoped access"
					>
						{grants.map((g) => {
							const phrase = grantPhrase(g.role, g.scope, g.scopeLabel);
							return (
								<li
									key={g.id}
									className="t-reveal inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-muted pr-0.5 pl-2.5 text-xs"
								>
									<span className="truncate">{phrase}</span>
									{admin && (
										<button
											type="button"
											onClick={() => revoke(g)}
											disabled={removeGrant.isPending}
											aria-label={`Remove ${phrase}`}
											className="relative grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-(--duration-quick) after:absolute after:-inset-2 hover:bg-foreground/10 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
										>
											<X className="size-3" aria-hidden />
										</button>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</div>
			<div className="col-start-2 row-start-2 md:col-start-auto md:row-start-auto">
				{admin && !isSelf ? (
					<RoleSelect
						value={m.role}
						onChange={changeRole}
						aria-label={`Role of ${m.name}`}
						className="h-8 w-full md:w-full"
					/>
				) : (
					<span className="text-sm">{roleName(m.role)}</span>
				)}
			</div>
			<span className="hidden text-xs whitespace-nowrap text-muted-foreground tabular-nums md:block">
				Joined {relativeTime(m.createdAt)}
			</span>
			<div className="col-start-3 row-start-1 justify-self-end md:col-start-auto md:row-start-auto">
				{admin && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Actions for ${m.name}`}
							>
								<MoreHorizontal />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={onAddAccess}>
								<ShieldPlus /> Add access
							</DropdownMenuItem>
							{!isSelf && (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem variant="destructive" onSelect={onRemove}>
										<X /> Remove from organization
									</DropdownMenuItem>
								</>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
		</li>
	);
}

function InvitationRow({
	invitation: inv,
}: {
	invitation: {
		id: string;
		email: string;
		role: string;
		expiresAt: string;
		url: string;
	};
}) {
	const cancel = useCancelInvitation();
	const days = daysUntil(inv.expiresAt);
	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">{inv.email}</p>
				<p className="text-xs text-muted-foreground tabular-nums">
					{roleName(inv.role)} · expires in {days} {days === 1 ? "day" : "days"}
				</p>
			</div>
			<div className="flex items-center gap-1">
				<CopyButton
					value={inv.url}
					label="invitation link"
					variant="outline"
					size="sm"
				>
					Copy link
				</CopyButton>
				<Button
					variant="ghost"
					size="sm"
					disabled={cancel.isPending}
					onClick={() =>
						cancel.mutate(inv.id, {
							onSuccess: () =>
								toast.success(`Invitation for ${inv.email} canceled`),
							onError: (err) =>
								toast.error("Couldn't cancel the invitation", {
									description: err.message,
								}),
						})
					}
				>
					Cancel
				</Button>
			</div>
		</li>
	);
}
