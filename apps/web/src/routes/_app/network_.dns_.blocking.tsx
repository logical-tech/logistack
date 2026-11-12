import type { HomeDns, HomeDnsBlocking } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Plus, RefreshCw, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { HomeDnsPage, NameTest } from "@/components/network/home-dns";
import { BLOCKLISTS, listName } from "@/components/network/presets";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	type DomainList,
	homeDnsApi,
	homeDnsListQuery,
	useHomeDnsMutation,
} from "@/lib/api/home-dns";

export const Route = createFileRoute("/_app/network_/dns_/blocking")({
	staticData: { crumb: "Blocking" },
	component: BlockingPage,
});

function BlockingPage() {
	const refresh = useHomeDnsMutation(() => homeDnsApi.refreshLists());
	return (
		<HomeDnsPage
			to="/network/dns/blocking"
			actions={() => (
				<Button
					variant="outline"
					disabled={refresh.isPending}
					onClick={() =>
						refresh.mutate(undefined, {
							onSuccess: () =>
								toast.success("Downloading the block lists again", {
									description:
										"Technitium swaps them in when the download finishes.",
								}),
							onError: (e) =>
								toast.error("Couldn't refresh the lists", {
									description: e.message,
								}),
						})
					}
				>
					<RefreshCw
						data-icon="inline-start"
						className={refresh.isPending ? "animate-spin" : undefined}
					/>
					Refresh lists now
				</Button>
			)}
		>
			{(dns) => (
				<div className="grid gap-8">
					<ListsPanel dns={dns} />
					<Panel title="Test a name" id="test-name">
						<div className="p-4">
							<NameTest />
						</div>
					</Panel>
					<div className="grid gap-8 lg:grid-cols-2">
						<DomainsPanel
							kind="allowed"
							title="Always allowed"
							hint="Answered even when a block list has them, subdomains included."
						/>
						<DomainsPanel
							kind="blocked"
							title="Always blocked"
							hint="Blocked for every device, subdomains included, whatever the lists say."
						/>
					</div>
				</div>
			)}
		</HomeDnsPage>
	);
}

const Url = z.url({ protocol: /^https?$/ });

function ListsPanel({ dns }: { dns: HomeDns }) {
	const blocking = dns.settings?.blocking ?? { enabled: false, listUrls: [] };
	const save = useHomeDnsMutation((b: HomeDnsBlocking) =>
		homeDnsApi.setBlocking(b),
	);
	const [url, setUrl] = useState("");
	const [error, setError] = useState<string>();
	// Optimistic view of the lists while a save is in flight.
	const shown = save.isPending && save.variables ? save.variables : blocking;
	const apply = (b: HomeDnsBlocking, done?: () => void) =>
		save.mutate(b, {
			onSuccess: done,
			onError: (e) =>
				toast.error("Couldn't save blocking", { description: e.message }),
		});
	const add = (u: string) =>
		!shown.listUrls.includes(u) &&
		apply({ ...shown, listUrls: [...shown.listUrls, u] }, () => setUrl(""));
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const parsed = Url.safeParse(url.trim());
		if (!parsed.success || url.includes(",")) {
			setError(
				"Enter an http or https address of a hosts file or domain list.",
			);
			return;
		}
		setError(undefined);
		add(parsed.data);
	};
	const suggestions = BLOCKLISTS.filter((l) => !shown.listUrls.includes(l.url));

	return (
		<Panel
			title="Block lists"
			id="block-lists"
			actions={
				save.isPending && (
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				)
			}
		>
			<div className="flex items-start justify-between gap-6 p-4">
				<div className="min-w-0">
					<label htmlFor="blocking-on" className="text-sm font-medium">
						Block ads, trackers and malware
					</label>
					<p
						id="blocking-on-msg"
						className="mt-1 max-w-[60ch] text-sm text-pretty text-muted-foreground"
					>
						Names on these lists get 0.0.0.0 instead of an answer, for every
						device using the home DNS. Lists refresh every 24 hours.
					</p>
				</div>
				<Switch
					id="blocking-on"
					aria-describedby="blocking-on-msg"
					checked={shown.enabled}
					disabled={save.isPending}
					onCheckedChange={(enabled) => apply({ ...shown, enabled })}
				/>
			</div>
			<ul className="divide-y border-t">
				{shown.listUrls.map((u) => (
					<li key={u} className="flex items-center gap-3 px-4 py-2.5">
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm">{listName(u) ?? "Custom list"}</p>
							<p className="truncate font-mono text-xs text-muted-foreground">
								{u}
							</p>
						</div>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`Remove ${listName(u) ?? u}`}
							disabled={save.isPending}
							onClick={() =>
								apply({
									...shown,
									listUrls: shown.listUrls.filter((x) => x !== u),
								})
							}
						>
							<X />
						</Button>
					</li>
				))}
				{shown.listUrls.length === 0 && (
					<li className="px-4 py-3 text-sm text-muted-foreground">
						No lists yet. Only the domains you block below are blocked.
					</li>
				)}
			</ul>
			<div className="grid gap-3 border-t bg-muted/30 p-4">
				{suggestions.length > 0 && (
					<div className="flex flex-wrap gap-2">
						{suggestions.map((l) => (
							<Button
								key={l.url}
								variant="outline"
								size="sm"
								title={l.description}
								disabled={save.isPending}
								onClick={() => add(l.url)}
							>
								<Plus data-icon="inline-start" />
								{l.name}
							</Button>
						))}
					</div>
				)}
				<form onSubmit={submit} className="flex gap-2" noValidate>
					<Input
						value={url}
						onChange={(e) => {
							setUrl(e.target.value);
							setError(undefined);
						}}
						placeholder="https://example.com/blocklist.txt"
						aria-label="Block list address"
						aria-invalid={error ? true : undefined}
						aria-describedby="list-url-msg"
						spellCheck={false}
						className="font-mono"
					/>
					<Button type="submit" variant="outline" disabled={save.isPending}>
						Add list
					</Button>
				</form>
				<p
					id="list-url-msg"
					className={error ? "text-xs text-bad-text" : "sr-only"}
					aria-live="polite"
				>
					{error}
				</p>
			</div>
		</Panel>
	);
}

const Domain = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/,
		"Enter a domain like example.com",
	);

function DomainsPanel({
	kind,
	title,
	hint,
}: {
	kind: DomainList;
	title: string;
	hint: string;
}) {
	const { data } = useQuery(homeDnsListQuery(kind));
	const add = useHomeDnsMutation((d: string) => homeDnsApi.add(kind, d));
	const remove = useHomeDnsMutation((d: string) => homeDnsApi.remove(kind, d));
	const [value, setValue] = useState("");
	const [error, setError] = useState<string>();
	const id = `${kind}-domain`;
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const parsed = Domain.safeParse(value);
		if (!parsed.success) {
			setError(parsed.error.issues[0]?.message);
			return;
		}
		add.mutate(parsed.data, {
			onSuccess: () => setValue(""),
			onError: (err) => setError(err.message),
		});
	};
	return (
		<Panel title={title} id={`${kind}-domains`}>
			<form onSubmit={submit} className="grid gap-1.5 border-b p-4" noValidate>
				<p className="text-xs text-muted-foreground">{hint}</p>
				<div className="flex gap-2">
					<Input
						id={id}
						value={value}
						onChange={(e) => {
							setValue(e.target.value);
							setError(undefined);
						}}
						placeholder="example.com"
						aria-label={`Add a domain to ${title.toLowerCase()}`}
						aria-invalid={error ? true : undefined}
						aria-describedby={`${id}-msg`}
						spellCheck={false}
						autoCapitalize="none"
						className="font-mono"
					/>
					<Button type="submit" variant="outline" disabled={add.isPending}>
						{kind === "allowed" ? "Allow" : "Block"}
					</Button>
				</div>
				<p
					id={`${id}-msg`}
					className={error ? "text-xs text-bad-text" : "sr-only"}
					aria-live="polite"
				>
					{error}
				</p>
			</form>
			{!data ? (
				<SkeletonRows rows={2} />
			) : data.length === 0 ? (
				<p className="px-4 py-6 text-center text-sm text-muted-foreground">
					None yet.
				</p>
			) : (
				<ul className="max-h-80 divide-y overflow-y-auto">
					{data.map((d) => (
						<li key={d} className="flex items-center gap-3 py-1.5 pr-2 pl-4">
							<span className="min-w-0 flex-1 truncate font-mono text-xs">
								{d}
							</span>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Remove ${d}`}
								disabled={remove.isPending && remove.variables === d}
								onClick={() =>
									remove.mutate(d, {
										onError: (err) =>
											toast.error(`Couldn't remove ${d}`, {
												description: err.message,
											}),
									})
								}
							>
								<X />
							</Button>
						</li>
					))}
				</ul>
			)}
		</Panel>
	);
}
