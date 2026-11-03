import { useQuery } from "@tanstack/react-query";
import { CircleAlert, KeyRound, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { GitHubMark, GoogleMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { instanceStatusQuery } from "@/lib/api/instance";
import type { SignInResult } from "@/lib/auth";
import { cn } from "@/lib/utils";

export function AuthHeading({
	title,
	children,
}: {
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="mb-7">
			<h1 className="text-xl font-semibold">{title}</h1>
			{children && (
				<p className="mt-1.5 text-sm text-muted-foreground">{children}</p>
			)}
		</div>
	);
}

export function FormAlert({ message }: { message: string | null }) {
	if (!message) return null;
	return (
		<div
			role="alert"
			key={message}
			className="t-swap flex items-start gap-2 rounded-md bg-bad/10 px-3 py-2.5 text-sm text-bad-text"
		>
			<CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
			{message}
		</div>
	);
}

export function OrDivider({ children = "or" }: { children?: ReactNode }) {
	return (
		<div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
			<span className="h-px flex-1 bg-border" />
			{children}
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}

type Provider = "passkey" | "github" | "google";

export type SocialProviders = { github: boolean; google: boolean };

/** The configured social providers; none until the server says otherwise. */
export function useSocialProviders(): SocialProviders {
	const { data } = useQuery(instanceStatusQuery);
	return data?.authProviders ?? { github: false, google: false };
}

/** Passkey first, then the social providers the server has credentials for. One pending at a time. */
export function AlternateSignIn({
	onPasskey,
	onSocial,
	disabled,
	showPasskey = true,
	providers,
}: {
	onPasskey: () => Promise<SignInResult>;
	onSocial: (p: "github" | "google") => Promise<SignInResult>;
	disabled?: boolean;
	showPasskey?: boolean;
	providers: SocialProviders;
}) {
	const [pending, setPending] = useState<Provider | null>(null);
	const run = (p: Provider, fn: () => Promise<unknown>) => async () => {
		setPending(p);
		try {
			await fn();
		} finally {
			setPending(null);
		}
	};
	const icon = (p: Provider, node: ReactNode) =>
		pending === p ? <Loader2 className="animate-spin" /> : node;
	const busy = disabled || pending !== null;

	return (
		<div className="grid gap-2">
			{showPasskey && (
				<Button
					type="button"
					variant="outline"
					size="lg"
					disabled={busy}
					onClick={run("passkey", onPasskey)}
				>
					{icon("passkey", <KeyRound />)}
					Sign in with a passkey
				</Button>
			)}
			{(providers.github || providers.google) && (
				<div
					className={cn(
						"grid gap-2",
						providers.github && providers.google && "grid-cols-2",
					)}
				>
					{providers.github && (
						<Button
							type="button"
							variant="outline"
							size="lg"
							disabled={busy}
							onClick={run("github", () => onSocial("github"))}
						>
							{icon("github", <GitHubMark />)}
							GitHub
						</Button>
					)}
					{providers.google && (
						<Button
							type="button"
							variant="outline"
							size="lg"
							disabled={busy}
							onClick={run("google", () => onSocial("google"))}
						>
							{icon("google", <GoogleMark />)}
							Google
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

export function SubmitButton({
	pending,
	children,
	className,
}: {
	pending: boolean;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Button
			type="submit"
			size="lg"
			disabled={pending}
			className={cn("w-full", className)}
		>
			{pending && <Loader2 className="animate-spin" />}
			{children}
		</Button>
	);
}
