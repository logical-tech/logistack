import { Loader2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { CopyButton } from "@/components/access/copy-button";
import {
	RoleSelect,
	ScopePicker,
	useScopeOptions,
} from "@/components/access/scope-picker";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCreateGrant, useInvite } from "@/lib/api/access";
import type { Invitation, Me, Scope, ScopeKind } from "@/lib/api/access-types";
import { issuesByKey } from "@/lib/form";

const KIND_WORD: Record<ScopeKind, string> = {
	organization: "the organization",
	folder: "folder",
	project: "project",
	environment: "environment",
	service: "service",
};

/** Owners and admins of the organization manage access; the server enforces it too. */
export const isOrgAdmin = (me: Me | undefined) =>
	Boolean(
		me?.grants.some(
			(g) =>
				g.scope.kind === "organization" &&
				(g.role === "owner" || g.role === "admin"),
		) && !me.keyScopes,
	);

export const roleName = (role: string) =>
	role.charAt(0).toUpperCase() + role.slice(1);

/** "Developer on folder Clients", "Viewer on the organization". */
export function grantPhrase(role: string, scope: Scope, label: string) {
	return scope.kind === "organization"
		? `${roleName(role)} on the organization`
		: `${roleName(role)} on ${KIND_WORD[scope.kind]} ${label}`;
}

function Shell({
	open,
	onOpenChange,
	title,
	description,
	children,
	footer,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	children: ReactNode;
	footer: ReactNode;
	onSubmit?: (e: FormEvent) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={onSubmit} noValidate className="grid min-w-0 gap-5">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					{children}
					<DialogFooter>{footer}</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

const inviteSchema = z.object({
	email: z.email("Enter the address the invitation is for."),
});

export function InviteDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const invite = useInvite();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("developer");
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [sent, setSent] = useState<Invitation | null>(null);

	function close(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setSent(null);
			setEmail("");
			setErrors({});
		}
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		const parsed = inviteSchema.safeParse({ email: email.trim() });
		if (!parsed.success) return setErrors(issuesByKey(parsed.error.issues));
		invite.mutate(
			{ email: parsed.data.email.toLowerCase(), role },
			{
				onSuccess: (inv) => setSent(inv),
				onError: (err) => setErrors({ email: err.message }),
			},
		);
	}

	if (sent)
		return (
			<Shell
				open={open}
				onOpenChange={close}
				title="Invitation ready"
				description={
					<>
						LogiStack doesn't send email. Share this link with{" "}
						<span className="font-medium text-foreground">{sent.email}</span>.
						It works once and expires in 7 days.
					</>
				}
				footer={
					<Button type="button" onClick={() => close(false)} autoFocus>
						Done
					</Button>
				}
			>
				<div className="t-reveal flex min-w-0 items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-3">
					<span className="min-w-0 flex-1 truncate font-mono text-xs select-all">
						{sent.url}
					</span>
					<CopyButton value={sent.url} label="invitation link" />
				</div>
			</Shell>
		);

	return (
		<Shell
			open={open}
			onOpenChange={close}
			onSubmit={submit}
			title="Invite member"
			description="They join with this role on the whole organization. Add narrower access afterwards."
			footer={
				<>
					<Button type="button" variant="ghost" onClick={() => close(false)}>
						Cancel
					</Button>
					<Button type="submit" disabled={invite.isPending}>
						{invite.isPending && <Loader2 className="animate-spin" />}
						Create invitation
					</Button>
				</>
			}
		>
			<Field id="invite-email" label="Email" error={errors.email}>
				<Input
					id="invite-email"
					type="email"
					inputMode="email"
					autoComplete="off"
					placeholder="teammate@company.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					aria-invalid={errors.email ? true : undefined}
					aria-describedby="invite-email-msg"
					autoFocus
				/>
			</Field>
			<Field
				id="invite-role"
				label="Role"
				hint="Viewer reads everything; developer also deploys and edits."
			>
				<RoleSelect
					id="invite-role"
					value={role}
					onChange={setRole}
					className="w-full"
				/>
			</Field>
		</Shell>
	);
}

export function AddAccessDialog({
	member,
	organizationId,
	onOpenChange,
}: {
	member: { userId: string; name: string } | null;
	organizationId: string;
	onOpenChange: (open: boolean) => void;
}) {
	const grant = useCreateGrant();
	const options = useScopeOptions();
	const [role, setRole] = useState("developer");
	const [scope, setScope] = useState<Scope | null>({ kind: "folder", id: "" });
	const [error, setError] = useState<string | null>(null);
	const ready = scope && (scope.kind === "organization" || scope.id);

	function close(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setError(null);
			setScope({ kind: "folder", id: "" });
		}
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!member) return;
		if (!scope || !ready) return setError("Choose where the role applies.");
		grant.mutate(
			{ userId: member.userId, role, scope },
			{
				onSuccess: (g) => {
					toast.success(
						`${member.name} is now ${grantPhrase(g.role, g.scope, g.scopeLabel)}`,
					);
					close(false);
				},
				onError: (err) => setError(err.message),
			},
		);
	}

	return (
		<Shell
			open={member !== null}
			onOpenChange={close}
			onSubmit={submit}
			title={`Add access for ${member?.name ?? ""}`}
			description="A role on a folder reaches every project, environment and service inside it."
			footer={
				<>
					<Button type="button" variant="ghost" onClick={() => close(false)}>
						Cancel
					</Button>
					<Button type="submit" disabled={grant.isPending}>
						{grant.isPending && <Loader2 className="animate-spin" />}
						Grant access
					</Button>
				</>
			}
		>
			<Field id="grant-role" label="Role">
				<RoleSelect
					id="grant-role"
					value={role}
					onChange={setRole}
					exclude={["owner"]}
					className="w-full"
				/>
			</Field>
			<Field id="grant-scope" label="Applies to" error={error ?? undefined}>
				<ScopePicker
					id="grant-scope"
					value={scope}
					onChange={(s) => {
						setScope(s);
						setError(null);
					}}
					organizationId={organizationId}
					invalid={Boolean(error)}
				/>
			</Field>
			<p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-pretty text-muted-foreground">
				{ready && scope ? (
					<>
						{member?.name} becomes{" "}
						<span className="font-medium text-foreground">
							{grantPhrase(role, scope, options.labelOf(scope))}
						</span>
						{scope.kind !== "organization" &&
							scope.kind !== "service" &&
							", and everything inside it"}
						.
					</>
				) : (
					"Pick a folder, project, environment or service."
				)}
			</p>
		</Shell>
	);
}
