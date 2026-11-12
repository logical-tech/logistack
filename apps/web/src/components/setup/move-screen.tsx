import { ArrowRight, CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { isMock } from "@/lib/api";
import type { SetupResult } from "@/lib/api/types";
import {
	type Diagnosis,
	diagnose,
	lanAddress,
	type Move,
} from "@/lib/setup-move";

// The Let's Encrypt wildcard over DNS-01 can take a minute or two; the mock gives up quickly.
const DEADLINE_MS = isMock ? 8_000 : 180_000;
const INTERVAL_MS = 3_000;
const AUTO_OPEN_MS = 1_500;

/**
 * An opaque no-cors response means DNS, TCP and TLS all worked; a rejection means the browser
 * cannot reach the address (no record, nothing listening, certificate not issued yet).
 */
async function answers(url: string) {
	try {
		await fetch(`${url}/api/health`, {
			mode: "no-cors",
			cache: "no-store",
			signal: AbortSignal.timeout(5_000),
		});
		return true;
	} catch {
		return false;
	}
}

/** Replaces the wizard once setup is saved: waits until this browser can reach the dashboard, then sends it there. */
export function MoveScreen({
	result,
	email,
	initial,
	autoOpen = true,
	browserHostname = window.location.hostname,
}: {
	result: SetupResult;
	email: string;
	/** Mock previews start in a fixed state. */
	initial?: Move;
	autoOpen?: boolean;
	/** Where this page was opened; previews pass a LAN one. */
	browserHostname?: string;
}) {
	const { url, hostname, resolvesTo } = result.dashboard;
	const [move, setMove] = useState<Move>(
		initial ?? { kind: "checking", since: Date.now() },
	);
	const lanIp = lanAddress(browserHostname);
	const tunnelPort =
		browserHostname === "localhost" && window.location.port
			? window.location.port
			: "3000";
	const sshHost = lanIp ?? result.publicIp ?? "<server>";

	useEffect(() => {
		if (move.kind !== "checking") return;
		let stopped = false;
		const tick = async () => {
			if (await answers(url)) {
				if (!stopped) setMove({ kind: "reachable" });
				return;
			}
			if (stopped) return;
			if (Date.now() - move.since >= DEADLINE_MS) {
				setMove({
					kind: "unreachable",
					diagnosis: diagnose({
						resolvesTo,
						publicIp: result.publicIp,
						browserHostname,
					}),
				});
				return;
			}
			timer = setTimeout(tick, INTERVAL_MS);
		};
		let timer = setTimeout(tick, 0);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [move, url, resolvesTo, result.publicIp, browserHostname]);

	useEffect(() => {
		if (move.kind !== "reachable" || !autoOpen) return;
		const t = setTimeout(() => window.location.assign(`${url}/`), AUTO_OPEN_MS);
		return () => clearTimeout(t);
	}, [move, url, autoOpen]);

	const failedRecords = result.dnsRecords.filter((r) => r.error);

	return (
		<div className="mx-auto w-full max-w-xl" aria-live="polite">
			{move.kind === "checking" && (
				<Header
					title={`Moving to ${hostname}`}
					lede="Setup is saved. This page opens the dashboard at its new address as soon as your browser can reach it."
				/>
			)}
			{move.kind === "reachable" && (
				<Header
					title={`LogiStack is ready at ${hostname}`}
					lede={`Sign in there with ${email}, the owner account you just created.`}
				/>
			)}
			{move.kind === "unreachable" && (
				<Header
					title={`${hostname} does not answer from here`}
					lede="Setup is complete. Only the move to the new address is left."
				/>
			)}

			<ol className="mt-8 grid gap-3 text-sm">
				<Step state="done">Owner and organization created</Step>
				{result.dnsRecords.length > 0 && (
					<Step state={failedRecords.length > 0 ? "failed" : "done"}>
						{failedRecords.length > 0
							? `Could not create ${failedRecords.map((r) => r.name).join(", ")}: ${failedRecords[0]?.error}`
							: `DNS records created for ${result.dnsRecords.map((r) => r.name).join(" and ")}`}
					</Step>
				)}
				<Step
					state={
						move.kind === "checking"
							? "running"
							: move.kind === "reachable"
								? "done"
								: "failed"
					}
				>
					{move.kind === "checking" ? (
						<>
							Waiting for <span className="font-mono text-xs">{url}</span> to
							answer
							<Elapsed since={move.since} />
							<span className="mt-0.5 block text-muted-foreground">
								The HTTPS certificate is issued on first use, which usually
								takes under two minutes.
							</span>
						</>
					) : move.kind === "reachable" ? (
						<>
							<span className="font-mono text-xs">{url}</span> answers
						</>
					) : (
						<>
							<span className="font-mono text-xs">{url}</span> did not answer
						</>
					)}
				</Step>
			</ol>

			{move.kind === "reachable" && (
				<a
					href={`${url}/`}
					className={buttonVariants({ size: "lg", className: "mt-8" })}
				>
					Open dashboard
					<ArrowRight data-icon="inline-end" aria-hidden />
				</a>
			)}

			{move.kind === "unreachable" && (
				<>
					<Explain diagnosis={move.diagnosis} hostname={hostname} />
					<Button
						type="button"
						variant="outline"
						className="mt-6"
						onClick={() => setMove({ kind: "checking", since: Date.now() })}
					>
						Check again
					</Button>
				</>
			)}

			{move.kind !== "reachable" && (
				<section className="mt-10 rounded-lg bg-muted/60 p-4 text-sm dark:bg-muted/40">
					<h2 className="font-medium">If you cannot get in</h2>
					<p className="mt-1 text-muted-foreground text-pretty">
						The dashboard also listens on the server's 127.0.0.1. Open an SSH
						tunnel, then go to{" "}
						<span className="font-mono text-xs text-foreground">
							http://localhost:{tunnelPort}
						</span>
						.
					</p>
					<Command
						value={`ssh -L ${tunnelPort}:127.0.0.1:${tunnelPort} root@${sshHost}`}
					/>
					{lanIp && (
						<p className="mt-3 text-muted-foreground text-pretty">
							On this network,{" "}
							<span className="font-mono text-xs text-foreground">
								http://{lanIp}
							</span>{" "}
							now shows where the dashboard lives.
						</p>
					)}
				</section>
			)}
		</div>
	);
}

function Header({ title, lede }: { title: string; lede: string }) {
	return (
		<div key={title} className="t-swap">
			<h1 className="text-2xl font-semibold text-balance [overflow-wrap:anywhere]">
				{title}
			</h1>
			<p className="mt-1.5 max-w-[60ch] text-sm text-muted-foreground text-pretty">
				{lede}
			</p>
		</div>
	);
}

function Step({
	state,
	children,
}: {
	state: "done" | "running" | "failed";
	children: ReactNode;
}) {
	return (
		<li className="flex gap-3">
			<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
				{state === "running" && (
					<Loader2
						className="size-4 animate-spin text-muted-foreground"
						aria-label="In progress"
					/>
				)}
				{state === "done" && (
					<CircleCheck
						className="t-reveal size-5 text-ok-text"
						aria-label="Done"
					/>
				)}
				{state === "failed" && (
					<CircleAlert
						className="t-reveal size-5 text-bad-text"
						aria-label="Failed"
					/>
				)}
			</span>
			<span className="min-w-0 flex-1">{children}</span>
		</li>
	);
}

function Elapsed({ since }: { since: number }) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(t);
	}, []);
	const s = Math.max(0, Math.floor((now - since) / 1_000));
	return (
		<span className="ml-1.5 text-muted-foreground tabular-nums">
			{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
		</span>
	);
}

function Command({ value }: { value: string }) {
	return (
		<div className="mt-3 flex items-center gap-2 rounded-md bg-background py-1.5 pr-1.5 pl-3 ring-1 ring-border">
			<code className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]">
				{value}
			</code>
			<CopyButton value={value} label="Copy the SSH command" />
		</div>
	);
}

function Explain({
	diagnosis: d,
	hostname,
}: {
	diagnosis: Diagnosis;
	hostname: string;
}) {
	const { title, body, fixes } = explain(d, hostname);
	return (
		<section className="mt-8">
			<h2 className="text-sm font-medium">{title}</h2>
			<p className="mt-1 text-sm text-muted-foreground text-pretty">{body}</p>
			{fixes.length > 0 && (
				<ul className="mt-3 grid gap-1.5 text-sm">
					{fixes.map((f) => (
						<li key={f} className="flex gap-2.5">
							<span
								className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground"
								aria-hidden
							/>
							<span className="text-pretty">{f}</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function explain(d: Diagnosis, hostname: string) {
	switch (d.kind) {
		case "nat":
			return {
				title: "The name points at your router's public address",
				body: `${hostname} resolves to ${d.publicIp}, but this browser is on your local network. Most home routers do not send that traffic back inside. Do one of these, then check again:`,
				fixes: [
					`Point the record at the server's LAN address, ${d.lanIp}.`,
					`Forward ports 80 and 443 on the router to ${d.lanIp}.`,
					`Add a local DNS record for ${hostname} pointing at ${d.lanIp}.`,
				],
			};
		case "unresolved":
			return {
				title: `${hostname} does not resolve yet`,
				body: "No DNS record answered for it when setup finished. If you manage DNS yourself, create the A records the wizard listed. New records can take a few minutes to appear.",
				fixes: [],
			};
		case "silent":
			return {
				title: `${hostname} resolves, but nothing answers`,
				body: `It points at ${d.addresses.join(", ")}. Check that:`,
				fixes: [
					"This is the server's address.",
					"Ports 80 and 443 are open in the server's and the provider's firewall.",
					"The certificate was issued. Let's Encrypt can take a few minutes.",
				],
			};
	}
}
