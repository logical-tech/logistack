import { createFileRoute, Link } from "@tanstack/react-router";
import { MailCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { AuthHeading, FormAlert, SubmitButton } from "@/components/auth-parts";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { auth } from "@/lib/auth";

export const Route = createFileRoute("/_auth/forgot-password")({
	validateSearch: z.object({ email: z.string().optional() }),
	component: ForgotPassword,
});

function ForgotPassword() {
	const search = Route.useSearch();
	const [email, setEmail] = useState(search.email ?? "");
	const [error, setError] = useState<string | undefined>();
	const [alert, setAlert] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [sentTo, setSentTo] = useState<string | null>(null);

	async function submit(e: FormEvent) {
		e.preventDefault();
		const parsed = z.email().safeParse(email.trim());
		if (!parsed.success) {
			setError("Enter the email you signed up with.");
			return;
		}
		setError(undefined);
		setPending(true);
		try {
			const res = await auth.requestPasswordReset(parsed.data);
			if (res.error) setAlert(res.error);
			else setSentTo(parsed.data);
		} finally {
			setPending(false);
		}
	}

	if (sentTo) {
		return (
			<div className="t-reveal">
				<div className="mb-5 grid size-11 place-items-center rounded-lg bg-muted text-foreground">
					<MailCheck className="size-5" strokeWidth={1.75} aria-hidden />
				</div>
				<AuthHeading title="Check your inbox">
					If an account exists for{" "}
					<span className="font-medium text-foreground">{sentTo}</span>, a reset
					link is on its way. It expires in one hour.
				</AuthHeading>
				<div className="grid gap-2">
					<Button asChild size="lg" variant="outline">
						<Link to="/sign-in">Back to sign in</Link>
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="lg"
						onClick={() => setSentTo(null)}
					>
						Use a different email
					</Button>
				</div>
			</div>
		);
	}

	return (
		<>
			<AuthHeading title="Reset your password">
				We'll email you a link to choose a new one.
			</AuthHeading>
			<form onSubmit={submit} noValidate className="grid gap-4">
				<FormAlert message={alert} />
				<Field id="email" label="Email" error={error}>
					<Input
						id="email"
						type="email"
						autoComplete="email"
						inputMode="email"
						placeholder="you@company.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						aria-invalid={error ? true : undefined}
						aria-describedby="email-msg"
						autoFocus
					/>
				</Field>
				<SubmitButton pending={pending}>Send reset link</SubmitButton>
			</form>
			<p className="mt-8 text-center text-sm text-muted-foreground">
				Remembered it?{" "}
				<Link
					to="/sign-in"
					className="font-medium text-foreground underline-offset-4 hover:underline"
				>
					Sign in
				</Link>
			</p>
		</>
	);
}
