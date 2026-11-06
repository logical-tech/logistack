import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight, Heart, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { meQuery } from "@/lib/api/access";
import {
	SPONSOR_URL,
	type SponsorStatus,
	sponsorQuery,
	useActivateSponsor,
	useRemoveSponsor,
} from "@/lib/api/sponsor";

export const Route = createFileRoute("/_app/settings/sponsor")({
	staticData: { crumb: "Sponsor" },
	component: Sponsor,
});

const date = (iso: string | null) =>
	iso
		? new Date(iso).toLocaleDateString(undefined, {
				day: "numeric",
				month: "long",
				year: "numeric",
			})
		: "—";

const money = (s: SponsorStatus) =>
	s.amount === null
		? "—"
		: new Intl.NumberFormat(undefined, {
				style: "currency",
				currency: (s.currency ?? "eur").toUpperCase(),
				maximumFractionDigits: 0,
			}).format(s.amount);

function Row({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-sm tabular">{children}</dd>
		</div>
	);
}

function Thanks({ s }: { s: SponsorStatus }) {
	return (
		<>
			<div className="flex items-start gap-4 p-5">
				<span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20">
					<Heart className="size-5 fill-current" aria-hidden />
				</span>
				<div className="min-w-0">
					<p className="text-base font-semibold text-balance">
						Thank you. This instance is sponsored.
					</p>
					<p className="mt-1 max-w-[60ch] text-sm text-pretty text-muted-foreground">
						The sponsor badge shows in the sidebar and the sponsorship cards are
						gone for everyone in this instance.
					</p>
				</div>
			</div>
			<dl className="divide-y border-t">
				<Row label="Sponsorship">
					{s.kind === "monthly" ? `${money(s)} a month` : `${money(s)}, once`}
					{s.sandbox && (
						<span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
							Sandbox
						</span>
					)}
				</Row>
				<Row label="Key issued">{date(s.since)}</Row>
				<Row label={s.kind === "monthly" ? "Renews before" : "Valid until"}>
					{date(s.expiresAt)}
				</Row>
			</dl>
		</>
	);
}

function Ask() {
	return (
		<div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
			<div className="min-w-0">
				<p className="text-base font-semibold text-balance">
					LogiStack has no paid edition
				</p>
				<p className="mt-1 max-w-[56ch] text-sm text-pretty text-muted-foreground">
					SSO, custom roles, the audit log and multi-node clusters are in the
					build you run. Sponsors pay for the hours behind releases, security
					fixes and the template catalog. Monthly from €5, or once.
				</p>
			</div>
			<Button asChild className="shrink-0">
				<a href={SPONSOR_URL} target="_blank" rel="noreferrer">
					<Heart className="size-4" aria-hidden />
					Become a sponsor
					<ArrowUpRight
						className="size-4 text-primary-foreground/70"
						aria-hidden
					/>
				</a>
			</Button>
		</div>
	);
}

function KeyForm({ admin, expired }: { admin: boolean; expired: boolean }) {
	const activate = useActivateSponsor();
	const [key, setKey] = useState("");
	const [error, setError] = useState<string | null>(null);

	const submit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		activate.mutate(key, {
			onSuccess: () => {
				setKey("");
				toast.success("Sponsor key activated", {
					description: "Thank you for keeping LogiStack free.",
				});
			},
			onError: (err) => setError(err.message),
		});
	};

	return (
		<form onSubmit={submit} className="grid gap-3 p-4">
			{expired && (
				<StatusLabel
					meta={{ label: "Your sponsor key expired", tone: "warn" }}
					className="text-sm"
				/>
			)}
			<div className="grid gap-1.5">
				<label htmlFor="sponsor-key" className="text-sm font-medium">
					Sponsor key
				</label>
				<p
					id="sponsor-key-help"
					className="max-w-[64ch] text-sm text-pretty text-muted-foreground"
				>
					After you pay, the key appears on the thank-you page and arrives by
					email. It starts with <code className="font-mono text-xs">lss_</code>.
				</p>
			</div>
			<div className="flex flex-col gap-2 sm:flex-row">
				<Input
					id="sponsor-key"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					placeholder="lss_…"
					autoComplete="off"
					spellCheck={false}
					disabled={!admin}
					aria-invalid={!!error}
					aria-describedby={error ? "sponsor-key-error" : "sponsor-key-help"}
					className="font-mono text-sm md:text-sm"
				/>
				<Button
					type="submit"
					variant="outline"
					disabled={!admin || !key.trim() || activate.isPending}
					className="shrink-0"
				>
					{activate.isPending && (
						<Loader2 className="size-4 animate-spin" aria-hidden />
					)}
					Activate
				</Button>
			</div>
			{error && (
				<p
					id="sponsor-key-error"
					role="alert"
					className="text-sm text-destructive"
				>
					{error}
				</p>
			)}
			{!admin && (
				<p className="text-sm text-muted-foreground">
					An owner or admin activates the key.
				</p>
			)}
		</form>
	);
}

function Sponsor() {
	const { data: s, isPending } = useQuery(sponsorQuery);
	const { data: me } = useQuery(meQuery);
	const admin = !!me?.roles.some((r) => r === "owner" || r === "admin");
	const remove = useRemoveSponsor();
	const [confirming, setConfirming] = useState(false);
	const active = s?.state === "active";

	return (
		<Page className="max-w-3xl">
			<PageHeader
				title="Sponsor"
				description="Every feature works without a sponsorship. A sponsor key adds a badge and hides the sponsorship cards."
				actions={
					active && admin ? (
						<Button variant="outline" onClick={() => setConfirming(true)}>
							Remove key
						</Button>
					) : undefined
				}
			/>
			<div className="grid gap-8">
				<Panel id="sponsorship" title="Sponsorship">
					{isPending || !s ? (
						<SkeletonRows rows={3} />
					) : active ? (
						<Thanks s={s} />
					) : (
						<Ask />
					)}
				</Panel>

				{s && !active && (
					<Panel id="key" title="Activate a key">
						<KeyForm admin={admin} expired={s.state === "expired"} />
					</Panel>
				)}

				<Panel id="privacy" title="What the key does">
					<ul className="grid gap-2 p-4 text-sm text-pretty text-muted-foreground">
						<li>
							The instance checks the key's signature itself. Nothing is sent
							anywhere to activate it.
						</li>
						<li>
							A monthly key renews itself: once a day, in the last ten days
							before it runs out, the worker sends the key, and only the key, to
							sponsors.logicaltech.it and stores the newer one it gets back.
						</li>
						<li>
							If that request fails, nothing changes until the key's own date.
						</li>
					</ul>
				</Panel>
			</div>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Remove the sponsor key?"
				description="The badge goes away and the sponsorship cards come back. You can paste the key again at any time."
				confirmLabel="Remove key"
				pending={remove.isPending}
				onConfirm={() =>
					remove.mutate(undefined, {
						onSuccess: () => setConfirming(false),
						onError: (err) =>
							toast.error("Couldn't remove the key", {
								description: err.message,
							}),
					})
				}
			/>
		</Page>
	);
}
