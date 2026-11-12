import type { HomeDns } from "@logistack/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	CircleAlert,
	CircleCheck,
	Ellipsis,
	Loader2,
	ServerCog,
	ShieldBan,
	ShieldCheck,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	type DomainList,
	homeDnsApi,
	useHomeDns,
	useHomeDnsMutation,
} from "@/lib/api/home-dns";
import { section } from "@/lib/nav";
import { HOME_DNS_STATUS } from "@/lib/status";
import { cn } from "@/lib/utils";

/** What the status badge says: `ready` with a message is still finishing, so it reads as busy. */
export function homeDnsMeta(dns: HomeDns) {
	const status = dns.status ?? "starting";
	if (status === "ready" && dns.statusMessage)
		return { label: "Finishing setup", tone: "busy" as const, live: true };
	return HOME_DNS_STATUS[status];
}

/**
 * Every home network page: header from the nav registry, then the states before the content
 * (not an instance admin, loading, feature off, and for pages that read Technitium, not ready).
 */
export function HomeDnsPage({
	to,
	title,
	description,
	actions,
	needsReady = true,
	className,
	children,
}: {
	className?: string;
	to: string;
	title?: ReactNode;
	description?: ReactNode;
	actions?: (dns: HomeDns) => ReactNode;
	needsReady?: boolean;
	children: (dns: HomeDns) => ReactNode;
}) {
	const s = section(to);
	const { data: dns, admin, me, isError, error, refetch } = useHomeDns();
	const live = dns?.enabled && (!needsReady || dns.status === "ready");
	return (
		<Page className={className}>
			<PageHeader
				title={title ?? s.title}
				description={description ?? s.description}
				actions={dns && live ? actions?.(dns) : undefined}
			/>
			{me && !admin ? (
				<EmptyState
					icon={ServerCog}
					title="Only instance admins manage the home network"
					description="The house's DNS belongs to the whole server, not to an organization. Ask an instance admin to add you."
				/>
			) : isError ? (
				<EmptyState
					icon={CircleAlert}
					title="Couldn't load the home DNS"
					description={error.message}
				>
					<Button variant="outline" onClick={() => refetch()}>
						Try again
					</Button>
				</EmptyState>
			) : !dns ? (
				<Panel title="Home DNS" id="home-dns-loading">
					<SkeletonRows rows={3} />
				</Panel>
			) : !dns.enabled ? (
				<EmptyState
					icon={ShieldBan}
					title="Home network DNS is off"
					description="Turn it on to block ads and trackers for every device in the house and answer local names like nas.home.lan."
				>
					<Button asChild>
						<Link to="/network/dns/new">Set up home DNS</Link>
					</Button>
				</EmptyState>
			) : !live ? (
				<NotReady dns={dns} />
			) : (
				children(dns)
			)}
		</Page>
	);
}

function NotReady({ dns }: { dns: HomeDns }) {
	const meta = homeDnsMeta(dns);
	const stopped = dns.status === "stopped";
	return (
		<div className="t-reveal flex flex-col items-center rounded-xl bg-muted/60 px-6 py-14 text-center dark:bg-muted/40">
			<StatusLabel meta={meta} />
			<h2 className="mt-4 text-md font-semibold">
				{stopped
					? "The home DNS is stopped"
					: dns.status === "error"
						? "The home DNS isn't answering"
						: "The home DNS is starting"}
			</h2>
			<p className="mt-1.5 max-w-[50ch] text-sm text-pretty text-muted-foreground">
				{stopped
					? "Devices that use it can't resolve names until you start it again."
					: (dns.statusMessage ??
						"This page fills in once Technitium answers. It usually takes under a minute.")}
			</p>
			{(stopped || dns.status === "error") && (
				<Button asChild variant="outline" className="mt-6">
					<Link to="/network/dns/settings">Open settings</Link>
				</Button>
			)}
		</div>
	);
}

const VERB: Record<DomainList, { done: string; icon: typeof ShieldBan }> = {
	allowed: { done: "Allowed", icon: ShieldCheck },
	blocked: { done: "Blocked", icon: ShieldBan },
};

/** Adds a domain to the allowed or blocked list, with a toast that says what changed. */
export function useListDomain() {
	const m = useHomeDnsMutation((v: { kind: DomainList; domain: string }) =>
		homeDnsApi.add(v.kind, v.domain),
	);
	return (kind: DomainList, domain: string) =>
		m.mutate(
			{ kind, domain },
			{
				onSuccess: () =>
					toast.success(`${VERB[kind].done} ${domain}`, {
						description:
							kind === "allowed"
								? "Answered even when a block list has it, subdomains included."
								: "Blocked for every device, subdomains included.",
					}),
				onError: (e) =>
					toast.error(`Couldn't update ${domain}`, { description: e.message }),
			},
		);
}

/** Row menu: allow or block a domain. */
export function DomainActions({
	domain,
	blocked,
}: {
	domain: string;
	/** The row was blocked, so Allow comes first. */
	blocked?: boolean;
}) {
	const list = useListDomain();
	const order: DomainList[] = blocked
		? ["allowed", "blocked"]
		: ["blocked", "allowed"];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Actions for ${domain}`}
					className="text-muted-foreground"
				>
					<Ellipsis />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{order.map((kind) => {
					const Icon = VERB[kind].icon;
					return (
						<DropdownMenuItem key={kind} onSelect={() => list(kind, domain)}>
							<Icon />
							{kind === "allowed" ? "Always allow" : "Always block"}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Resolves a name through the home DNS and says whether it was blocked, with the answers. */
export function NameTest({
	placeholder = "doubleclick.net",
	autoFocus,
}: {
	placeholder?: string;
	autoFocus?: boolean;
}) {
	const [name, setName] = useState("");
	const test = useMutation({ mutationFn: (n: string) => homeDnsApi.test(n) });
	const r = test.data;
	const run = () => {
		const n = name.trim();
		if (n) test.mutate(n);
	};
	return (
		<div className="grid gap-3">
			{/* Not a form: it also sits inside the wizard's form, where Enter must not finish the wizard. */}
			<div className="flex gap-2">
				<Input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={placeholder}
					aria-label="Name to resolve"
					spellCheck={false}
					autoCapitalize="none"
					autoFocus={autoFocus}
					className="max-w-sm font-mono"
					onKeyDown={(e) => {
						if (e.key !== "Enter") return;
						e.preventDefault();
						e.stopPropagation();
						run();
					}}
				/>
				<Button
					type="button"
					onClick={run}
					variant="outline"
					disabled={test.isPending || !name.trim()}
				>
					{test.isPending && <Loader2 className="animate-spin" />}
					Resolve
				</Button>
			</div>
			<div aria-live="polite">
				{test.isError && (
					<p className="t-swap text-sm text-bad-text">{test.error.message}</p>
				)}
				{r && !test.isPending && (
					<div
						key={`${r.name}-${r.blocked}`}
						className="t-swap flex items-start gap-3 rounded-lg bg-muted/60 p-3 dark:bg-muted/40"
					>
						{r.blocked ? (
							<ShieldBan className="mt-0.5 size-4 shrink-0 text-bad-text" />
						) : (
							<CircleCheck className="mt-0.5 size-4 shrink-0 text-ok-text" />
						)}
						<div className="min-w-0 text-sm">
							<p className={cn("font-medium", r.blocked && "text-bad-text")}>
								<span className="font-mono">{r.name}</span>{" "}
								{r.blocked ? "is blocked" : "resolves"}
							</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								{r.answers.length
									? r.answers.map((a) => (
											<span
												key={`${a.type}-${a.data}`}
												className="mr-3 inline-block font-mono"
											>
												{a.type} {a.data}
											</span>
										))
									: `No answer (${r.rcode})`}
							</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
