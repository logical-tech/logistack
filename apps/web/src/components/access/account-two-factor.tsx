import { useQuery, useQueryClient } from "@tanstack/react-query";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Download, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { z } from "zod";
import { CopyButton } from "@/components/access/copy-button";
import { Field } from "@/components/field";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSeparator,
	InputOTPSlot,
} from "@/components/ui/input-otp";
import { TestPanel } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { account, type TwoFactorSetup, totpSecret } from "@/lib/account";

type V = { password: string; code: string; saved: boolean };
const DEFAULTS: V = { password: "", code: "", saved: false };

export const twoFactorQuery = {
	queryKey: ["account", "two-factor"],
	queryFn: () => account.twoFactorEnabled(),
};

/** Groups a base32 secret in fours so it can be typed by hand. */
const grouped = (secret: string) =>
	secret.match(/.{1,4}/g)?.join(" ") ?? secret;

function QrCode({ uri }: { uri: string }) {
	// Black on white whatever the theme: authenticator cameras expect it.
	const svg = useMemo(
		() =>
			renderSVG(uri, {
				border: 2,
				ecc: "M",
				blackColor: "#0b0d12",
				whiteColor: "#ffffff",
			}),
		[uri],
	);
	return (
		<div
			role="img"
			aria-label="QR code for your authenticator app"
			className="size-44 shrink-0 overflow-hidden rounded-lg bg-white p-1 shadow-card ring-1 ring-black/10 [&>svg]:size-full"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: uqr renders a self-made SVG from the otpauth URI, no user markup.
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}

function ScanStep({ w, setup }: { w: WizardApi<V>; setup: TwoFactorSetup }) {
	const { code } = w.values;
	const { phase } = w.test;
	const { runTest } = w;
	// Six digits verify on their own; Enter or the button work too.
	useEffect(() => {
		if (code.length === 6 && phase === "idle") runTest();
	}, [code, phase, runTest]);
	const secret = totpSecret(setup.totpURI);
	return (
		<div className="grid gap-6">
			<div className="flex flex-col gap-5 md:flex-row md:items-start">
				<QrCode uri={setup.totpURI} />
				<div className="grid min-w-0 flex-1 gap-4">
					<p className="max-w-[46ch] text-sm text-muted-foreground">
						Open 1Password, Google Authenticator, Authy or any TOTP app and scan
						the code. No camera? Enter the setup key instead.
					</p>
					<div className="grid gap-1.5">
						<span className="text-sm font-medium">Setup key</span>
						<div className="flex items-center gap-1 rounded-md bg-muted/60 py-1 pr-1 pl-3 dark:bg-muted/40">
							<code className="min-w-0 flex-1 font-mono text-sm">
								{grouped(secret)}
							</code>
							<CopyButton value={secret} label="setup key" />
						</div>
					</div>
					<Field
						id="wz-code"
						label="Code from the app"
						error={w.error("code")}
						hint="It changes every 30 seconds."
					>
						<InputOTP
							id="wz-code"
							maxLength={6}
							pattern={REGEXP_ONLY_DIGITS}
							value={code}
							onChange={(v) => w.set("code", v)}
							aria-label="Six-digit code"
							aria-describedby="wz-code-msg"
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
					</Field>
				</div>
			</div>
			<TestPanel
				w={w}
				action="Verify code"
				idle="Enter the six digits your app shows now."
			/>
		</div>
	);
}

function BackupStep({ w, codes }: { w: WizardApi<V>; codes: string[] }) {
	const text = `LogiStack backup codes\nEach code signs you in once when your authenticator isn't at hand.\n\n${codes.join("\n")}\n`;
	function download() {
		const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
		const a = Object.assign(document.createElement("a"), {
			href: url,
			download: "logistack-backup-codes.txt",
		});
		a.click();
		URL.revokeObjectURL(url);
		w.set("saved", true);
	}
	return (
		<div className="grid gap-5">
			<ol className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-muted/60 p-4 font-mono text-sm tabular sm:grid-cols-5 dark:bg-muted/40">
				{codes.map((c) => (
					<li key={c}>{c}</li>
				))}
			</ol>
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" variant="outline" onClick={download}>
					<Download data-icon="inline-start" />
					Download as .txt
				</Button>
				<CopyButton
					value={codes.join("\n")}
					label="backup codes"
					variant="outline"
					size="default"
				>
					Copy all
				</CopyButton>
			</div>
			<label htmlFor="wz-saved" className="flex items-center gap-2.5 text-sm">
				<Checkbox
					id="wz-saved"
					checked={w.values.saved}
					onCheckedChange={(v) => w.set("saved", v === true)}
					aria-invalid={w.error("saved") ? true : undefined}
				/>
				I saved these codes somewhere safe
			</label>
			{w.error("saved") && (
				<p className="text-xs text-bad-text">{w.error("saved")}</p>
			)}
		</div>
	);
}

/** Two-factor status and its three-step enrollment, shown in place when `step` is set. */
export function TwoFactorSection({
	step,
	onStepChange,
	onClose,
}: {
	step: string | undefined;
	onStepChange: (step: string, opts: { replace: boolean }) => void;
	onClose: () => void;
}) {
	const qc = useQueryClient();
	const { data: enabled, isPending } = useQuery(twoFactorQuery);
	const [disabling, setDisabling] = useState(false);
	const setup = useRef<TwoFactorSetup | null>(null);

	const steps: WizardStep<V>[] = [
		{
			id: "password",
			title: "Confirm it's you",
			description:
				"Two-factor protects every sign-in to this instance. Enter your password to start.",
			schema: z.object({ password: z.string().min(1, "Enter your password.") }),
			test: async (v) => {
				setup.current = await account.enableTwoFactor(v.password);
				return {
					ok: true,
					message: "Password confirmed",
					detail: "Your authenticator key is ready on the next step.",
				};
			},
			render: (w) => (
				<div className="grid max-w-sm gap-5">
					<Field id="wz-password" label="Password" error={w.error("password")}>
						<Input
							type="password"
							autoComplete="current-password"
							{...w.bind("password")}
						/>
					</Field>
					<TestPanel
						w={w}
						action="Confirm password"
						idle="We check it before creating your key."
					/>
				</div>
			),
		},
		{
			id: "scan",
			title: "Scan and verify",
			description:
				"Add LogiStack to your authenticator app, then type the code it shows.",
			schema: z.object({
				code: z.string().regex(/^\d{6}$/, "Enter all six digits."),
			}),
			test: async (v) => {
				await account.verifyTotp(v.code);
				return {
					ok: true,
					message: "Two-factor is on",
					detail: "The next sign-in asks for a code after your password.",
				};
			},
			render: (w) =>
				setup.current ? (
					<ScanStep w={w} setup={setup.current} />
				) : (
					<p className="text-sm text-muted-foreground">
						Go back and confirm your password first.
					</p>
				),
		},
		{
			id: "backup",
			title: "Save backup codes",
			description:
				"Each code signs you in once if you lose your phone. They won't be shown again.",
			schema: z.object({
				saved: z.literal(true, "Download or copy the codes first."),
			}),
			render: (w) => (
				<BackupStep w={w} codes={setup.current?.backupCodes ?? []} />
			),
		},
	];

	const enrolling = step !== undefined && !enabled;

	return (
		<section aria-labelledby="two-factor" className="min-w-0">
			<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				<div className="flex flex-col items-start gap-4 p-5 sm:flex-row sm:justify-between">
					<div className="flex min-w-0 gap-3">
						<span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
							{enabled ? (
								<ShieldCheck className="size-4.5" strokeWidth={1.75} />
							) : (
								<ShieldOff className="size-4.5" strokeWidth={1.75} />
							)}
						</span>
						<div className="min-w-0">
							<h2
								id="two-factor"
								className="text-sm font-semibold [font-stretch:100%]"
							>
								Two-factor authentication
							</h2>
							<p className="mt-0.5 flex items-center gap-2 text-sm text-muted-foreground">
								{isPending ? (
									"Checking…"
								) : (
									<>
										<StatusDot
											meta={{
												label: enabled ? "On" : "Off",
												tone: enabled ? "ok" : "idle",
											}}
										/>
										{enabled
											? "On. Sign-ins ask for a code from your authenticator app."
											: "Off. A stolen password is enough to sign in as you."}
									</>
								)}
							</p>
						</div>
					</div>
					{!isPending &&
						(enabled ? (
							<Button variant="outline" onClick={() => setDisabling(true)}>
								Turn off
							</Button>
						) : enrolling ? (
							<Button variant="ghost" onClick={onClose}>
								Cancel setup
							</Button>
						) : (
							<Button
								onClick={() => onStepChange("password", { replace: false })}
							>
								Set up two-factor
							</Button>
						))}
				</div>
				{enrolling && (
					<div className="t-reveal border-t px-5 pt-6 pb-5">
						<Wizard
							id="account-two-factor"
							steps={steps}
							defaultValues={DEFAULTS}
							secretKeys={["password", "code", "saved"]}
							step={step}
							onStepChange={onStepChange}
							finishLabel="Done"
							onComplete={async () => {
								await qc.invalidateQueries({
									queryKey: twoFactorQuery.queryKey,
								});
								toast.success("Two-factor authentication is on");
								onClose();
							}}
						/>
					</div>
				)}
			</div>
			<DisableDialog
				open={disabling}
				onOpenChange={setDisabling}
				onDone={() =>
					qc.invalidateQueries({ queryKey: twoFactorQuery.queryKey })
				}
			/>
		</section>
	);
}

function DisableDialog({
	open,
	onOpenChange,
	onDone,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDone: () => void;
}) {
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);
	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!password) return setError("Enter your password.");
		setPending(true);
		try {
			await account.disableTwoFactor(password);
			toast("Two-factor authentication is off");
			setPassword("");
			onOpenChange(false);
			onDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} noValidate className="grid gap-5">
					<DialogHeader>
						<DialogTitle>Turn off two-factor?</DialogTitle>
						<DialogDescription>
							Your password alone will sign you in again, and your backup codes
							stop working.
						</DialogDescription>
					</DialogHeader>
					<Field id="disable-password" label="Password" error={error}>
						<Input
							id="disable-password"
							type="password"
							autoComplete="current-password"
							value={password}
							onChange={(e) => {
								setPassword(e.target.value);
								setError(undefined);
							}}
							aria-invalid={error ? true : undefined}
							aria-describedby="disable-password-msg"
							autoFocus
						/>
					</Field>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Keep it on
						</Button>
						<Button type="submit" variant="destructive" disabled={pending}>
							{pending && <Loader2 className="animate-spin" />}
							Turn off two-factor
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
