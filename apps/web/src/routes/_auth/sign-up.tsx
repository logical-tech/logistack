import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import {
	AlternateSignIn,
	AuthHeading,
	FormAlert,
	OrDivider,
	SubmitButton,
	useSocialProviders,
} from "@/components/auth-parts";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { auth, type SignInResult } from "@/lib/auth";
import { issuesByKey } from "@/lib/form";

export const Route = createFileRoute("/_auth/sign-up")({
	component: SignUp,
});

const schema = z.object({
	name: z.string().trim().min(1, "Tell us what to call you."),
	email: z.email("Enter a valid email address."),
	password: z.string().min(12, "Use at least 12 characters."),
});

function SignUp() {
	const navigate = useNavigate();
	const [values, setValues] = useState({ name: "", email: "", password: "" });
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [alert, setAlert] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const providers = useSocialProviders();
	const set = (k: keyof typeof values) => (e: { target: { value: string } }) =>
		setValues((v) => ({ ...v, [k]: e.target.value }));

	async function handle(result: SignInResult) {
		if (result.kind === "error") setAlert(result.message);
		else await navigate({ to: "/" });
		return result;
	}

	async function submit(e: FormEvent) {
		e.preventDefault();
		const parsed = schema.safeParse(values);
		if (!parsed.success) {
			setErrors(issuesByKey(parsed.error.issues));
			return;
		}
		setErrors({});
		setAlert(null);
		setPending(true);
		try {
			await handle(await auth.signUp(parsed.data));
		} finally {
			setPending(false);
		}
	}

	const strength = values.password.length;

	return (
		<>
			<AuthHeading title="Create your account">
				You'll join the organizations you've been invited to.
			</AuthHeading>

			{(providers.github || providers.google) && (
				<>
					<AlternateSignIn
						providers={providers}
						showPasskey={false}
						disabled={pending}
						onPasskey={auth.signInPasskey}
						onSocial={async (p) => handle(await auth.signInSocial(p))}
					/>
					<OrDivider>or with email</OrDivider>
				</>
			)}

			<form onSubmit={submit} noValidate className="grid gap-4">
				<FormAlert message={alert} />
				<Field id="name" label="Name" error={errors.name}>
					<Input
						id="name"
						autoComplete="name"
						value={values.name}
						onChange={set("name")}
						aria-invalid={errors.name ? true : undefined}
						aria-describedby="name-msg"
					/>
				</Field>
				<Field id="email" label="Work email" error={errors.email}>
					<Input
						id="email"
						type="email"
						autoComplete="email"
						inputMode="email"
						placeholder="you@company.com"
						value={values.email}
						onChange={set("email")}
						aria-invalid={errors.email ? true : undefined}
						aria-describedby="email-msg"
					/>
				</Field>
				<Field
					id="password"
					label="Password"
					error={errors.password}
					hint="At least 12 characters. A passphrase works well."
				>
					<Input
						id="password"
						type="password"
						autoComplete="new-password"
						value={values.password}
						onChange={set("password")}
						aria-invalid={errors.password ? true : undefined}
						aria-describedby="password-msg"
					/>
					<div className="flex gap-1" aria-hidden>
						{[4, 8, 12, 16].map((t) => (
							<span
								key={t}
								className={
									strength >= t
										? "h-1 flex-1 rounded-full bg-foreground transition-colors duration-(--duration-fast)"
										: "h-1 flex-1 rounded-full bg-muted-foreground/15 transition-colors duration-(--duration-fast)"
								}
							/>
						))}
					</div>
				</Field>
				<SubmitButton pending={pending}>Create account</SubmitButton>
			</form>

			<p className="mt-8 text-center text-sm text-muted-foreground">
				Already have an account?{" "}
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
