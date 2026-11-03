import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ssoStatusQuery } from "@/lib/api/sso";
import { auth, type SignInResult } from "@/lib/auth";
import { issuesByKey } from "@/lib/form";
import { redirectParam } from "@/lib/search";

const search = z.object({
	redirect: redirectParam,
	/** Set by better-auth when an SSO sign-in comes back with an error. */
	error: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_auth/sign-in")({
	validateSearch: search,
	component: SignIn,
});

const schema = z.object({
	email: z.email("Enter the email you signed up with."),
	password: z.string().min(1, "Enter your password."),
});

const ssoSchema = z.object({
	email: z.email("Enter your work email."),
});

function SignIn() {
	const { redirect, error } = Route.useSearch();
	const navigate = useNavigate();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [remember, setRemember] = useState(true);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [alert, setAlert] = useState<string | null>(
		error
			? `Single sign-on didn't finish (${error.replaceAll("_", " ")}).`
			: null,
	);
	const [pending, setPending] = useState(false);
	const [sso, setSso] = useState(false);
	const providers = useSocialProviders();
	const { data: ssoStatus } = useQuery(ssoStatusQuery);

	async function submitSso(e: FormEvent) {
		e.preventDefault();
		const parsed = ssoSchema.safeParse({ email });
		if (!parsed.success) {
			setErrors(issuesByKey(parsed.error.issues));
			return;
		}
		setErrors({});
		setAlert(null);
		setPending(true);
		const result = await auth.signInSso(parsed.data.email, redirect ?? "/");
		// While the browser heads to the identity provider the button keeps spinning.
		if (result.kind === "redirecting") return;
		setPending(false);
		await handle(result);
	}

	if (sso)
		return (
			<>
				<AuthHeading title="Sign in with SSO">
					Your work email picks your organization's identity provider.
				</AuthHeading>
				<form onSubmit={submitSso} noValidate className="grid gap-4">
					<FormAlert message={alert} />
					<Field id="sso-email" label="Work email" error={errors.email}>
						<Input
							id="sso-email"
							type="email"
							autoComplete="username"
							inputMode="email"
							autoFocus
							placeholder="you@company.com"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							aria-invalid={errors.email ? true : undefined}
							aria-describedby="sso-email-msg"
						/>
					</Field>
					<SubmitButton pending={pending}>Continue</SubmitButton>
				</form>
				<p className="mt-8 text-center text-sm text-muted-foreground">
					<button
						type="button"
						onClick={() => {
							setSso(false);
							setErrors({});
							setAlert(null);
						}}
						className="font-medium text-foreground underline-offset-4 hover:underline"
					>
						Use a passkey or password instead
					</button>
				</p>
			</>
		);

	async function handle(result: SignInResult) {
		if (result.kind === "error") setAlert(result.message);
		if (result.kind === "two-factor") {
			await navigate({ to: "/two-factor", search: { redirect } });
		}
		if (result.kind === "signed-in") await navigate({ href: redirect ?? "/" });
		return result;
	}

	async function submit(e: FormEvent) {
		e.preventDefault();
		const parsed = schema.safeParse({ email, password });
		if (!parsed.success) {
			setErrors(issuesByKey(parsed.error.issues));
			return;
		}
		setErrors({});
		setAlert(null);
		setPending(true);
		try {
			await handle(await auth.signInEmail({ ...parsed.data, remember }));
		} finally {
			setPending(false);
		}
	}

	return (
		<>
			<AuthHeading title="Sign in to LogiStack">
				Welcome back. Use a passkey or your email.
			</AuthHeading>

			<AlternateSignIn
				providers={providers}
				disabled={pending}
				onPasskey={async () => handle(await auth.signInPasskey())}
				onSocial={async (p) => handle(await auth.signInSocial(p))}
			/>
			{ssoStatus?.enabled && (
				<Button
					type="button"
					variant="outline"
					size="lg"
					className="mt-2 w-full"
					disabled={pending}
					onClick={() => {
						setSso(true);
						setErrors({});
						setAlert(null);
					}}
				>
					<Building2 />
					Continue with SSO
				</Button>
			)}

			<OrDivider>or with email</OrDivider>

			<form onSubmit={submit} noValidate className="grid gap-4">
				<FormAlert message={alert} />
				<Field id="email" label="Email" error={errors.email}>
					<Input
						id="email"
						type="email"
						autoComplete="username webauthn"
						inputMode="email"
						placeholder="you@company.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						aria-invalid={errors.email ? true : undefined}
						aria-describedby="email-msg"
					/>
				</Field>
				<div className="grid gap-2">
					<Field id="password" label="Password" error={errors.password}>
						<Input
							id="password"
							type="password"
							autoComplete="current-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							aria-invalid={errors.password ? true : undefined}
							aria-describedby="password-msg"
						/>
					</Field>
				</div>
				<div className="flex items-center justify-between">
					<label
						htmlFor="remember"
						className="flex items-center gap-2 text-sm text-muted-foreground"
					>
						<Switch
							id="remember"
							size="sm"
							checked={remember}
							onCheckedChange={setRemember}
						/>
						Keep me signed in
					</label>
					<Link
						to="/forgot-password"
						search={{ email: email || undefined }}
						className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
					>
						Forgot password?
					</Link>
				</div>
				<SubmitButton pending={pending}>Sign in</SubmitButton>
			</form>

			<p className="mt-8 text-center text-sm text-muted-foreground">
				New to this instance?{" "}
				<Link
					to="/sign-up"
					className="font-medium text-foreground underline-offset-4 hover:underline"
				>
					Create an account
				</Link>
			</p>
		</>
	);
}
