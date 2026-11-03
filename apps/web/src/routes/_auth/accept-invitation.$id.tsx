import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthHeading, FormAlert, SubmitButton } from "@/components/auth-parts";
import { buttonVariants } from "@/components/ui/button";
import { isMock } from "@/lib/api";
import { auth, authClient, useSessionUser } from "@/lib/auth";

export const Route = createFileRoute("/_auth/accept-invitation/$id")({
	component: AcceptInvitation,
});

async function accept(invitationId: string): Promise<string | null> {
	if (isMock) {
		await new Promise((r) => setTimeout(r, 600));
		return null;
	}
	const res = await authClient.organization.acceptInvitation({ invitationId });
	if (res.error)
		return res.error.message ?? "This invitation can't be accepted.";
	const organizationId = res.data?.invitation.organizationId;
	if (organizationId)
		await authClient.organization.setActive({ organizationId });
	return null;
}

function AcceptInvitation() {
	const { id } = Route.useParams();
	const user = useSessionUser();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const here = `/accept-invitation/${id}`;

	if (!user)
		return (
			<>
				<AuthHeading title="You're invited">
					Sign in with the email address the invitation was sent to, then accept
					it here.
				</AuthHeading>
				<div className="grid gap-2">
					<Link
						to="/sign-in"
						search={{ redirect: here }}
						className={buttonVariants({ size: "lg", className: "w-full" })}
					>
						Sign in to accept
					</Link>
					<Link
						to="/sign-up"
						className={buttonVariants({
							variant: "outline",
							size: "lg",
							className: "w-full",
						})}
					>
						Create an account
					</Link>
				</div>
				<p className="mt-6 text-sm text-pretty text-muted-foreground">
					New here? Create the account with the invited address, then open this
					link again.
				</p>
			</>
		);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setPending(true);
		setError(null);
		try {
			const failure = await accept(id);
			if (failure) return setError(failure);
			await qc.invalidateQueries();
			await navigate({ to: "/" });
		} finally {
			setPending(false);
		}
	}

	return (
		<form onSubmit={submit} className="grid gap-4">
			<AuthHeading title="Join the organization">
				You're signed in as{" "}
				<span className="font-medium text-foreground">{user.email}</span>.
				Accepting gives you the role the invitation names; an admin can widen it
				later.
			</AuthHeading>
			<FormAlert message={error} />
			<SubmitButton pending={pending}>Accept invitation</SubmitButton>
			<p className="text-center text-sm text-muted-foreground">
				Wrong account?{" "}
				<button
					type="button"
					className="font-medium text-foreground underline-offset-4 hover:underline"
					onClick={async () => {
						await auth.signOut();
						await navigate({ to: "/sign-in", search: { redirect: here } });
					}}
				>
					Sign in as someone else
				</button>
			</p>
		</form>
	);
}
