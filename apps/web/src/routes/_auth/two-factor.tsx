import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { AuthHeading, FormAlert, SubmitButton } from "@/components/auth-parts";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSeparator,
	InputOTPSlot,
} from "@/components/ui/input-otp";
import { Switch } from "@/components/ui/switch";
import { auth, type SignInResult } from "@/lib/auth";
import { redirectParam } from "@/lib/search";

export const Route = createFileRoute("/_auth/two-factor")({
	validateSearch: z.object({
		redirect: redirectParam,
		method: z.enum(["totp", "backup"]).optional(),
	}),
	component: TwoFactor,
});

function TwoFactor() {
	const { redirect, method = "totp" } = Route.useSearch();
	const navigate = useNavigate();
	const [code, setCode] = useState("");
	const [backup, setBackup] = useState("");
	const [trust, setTrust] = useState(false);
	const [alert, setAlert] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function verify(run: () => Promise<SignInResult>) {
		setAlert(null);
		setPending(true);
		try {
			const result = await run();
			if (result.kind === "error") setAlert(result.message);
			else await navigate({ href: redirect ?? "/" });
		} finally {
			setPending(false);
		}
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		if (method === "totp") {
			if (code.length !== 6) return setAlert("Enter all six digits.");
			return verify(() => auth.verifyTotp(code, trust));
		}
		if (!backup.trim()) return setAlert("Enter one of your backup codes.");
		return verify(() => auth.verifyBackupCode(backup.trim()));
	}

	return (
		<>
			{method === "totp" ? (
				<AuthHeading title="Two-factor authentication">
					Enter the 6-digit code from your authenticator app.
				</AuthHeading>
			) : (
				<AuthHeading title="Use a backup code">
					Each backup code works once. You saved them when you turned on
					two-factor.
				</AuthHeading>
			)}

			<form onSubmit={submit} noValidate className="grid gap-5">
				<FormAlert message={alert} />
				{method === "totp" ? (
					<div className="grid gap-4">
						<InputOTP
							maxLength={6}
							pattern={REGEXP_ONLY_DIGITS}
							value={code}
							onChange={setCode}
							onComplete={(v) => verify(() => auth.verifyTotp(v, trust))}
							autoFocus
							aria-label="Authentication code"
							containerClassName="justify-between"
						>
							<InputOTPGroup>
								<InputOTPSlot index={0} />
								<InputOTPSlot index={1} />
								<InputOTPSlot index={2} />
							</InputOTPGroup>
							<InputOTPSeparator />
							<InputOTPGroup>
								<InputOTPSlot index={3} />
								<InputOTPSlot index={4} />
								<InputOTPSlot index={5} />
							</InputOTPGroup>
						</InputOTP>
						<label
							htmlFor="trust"
							className="flex items-center gap-2 text-sm text-muted-foreground"
						>
							<Switch
								id="trust"
								size="sm"
								checked={trust}
								onCheckedChange={setTrust}
							/>
							Trust this browser for 30 days
						</label>
					</div>
				) : (
					<Field id="backup" label="Backup code" hint="Format: abcde-12345">
						<Input
							id="backup"
							autoComplete="one-time-code"
							spellCheck={false}
							className="font-mono tracking-wider"
							placeholder="abcde-12345"
							value={backup}
							onChange={(e) => setBackup(e.target.value)}
							aria-describedby="backup-msg"
							autoFocus
						/>
					</Field>
				)}
				<SubmitButton pending={pending}>Verify</SubmitButton>
			</form>

			<div className="mt-8 flex flex-col items-center gap-2 text-sm text-muted-foreground">
				<Link
					to="/two-factor"
					search={{ redirect, method: method === "totp" ? "backup" : "totp" }}
					className="underline-offset-4 hover:text-foreground hover:underline"
				>
					{method === "totp"
						? "Lost your device? Use a backup code"
						: "Use your authenticator app instead"}
				</Link>
				<Link
					to="/sign-in"
					className="underline-offset-4 hover:text-foreground hover:underline"
				>
					Back to sign in
				</Link>
			</div>
		</>
	);
}
