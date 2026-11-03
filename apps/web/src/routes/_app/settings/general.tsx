import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useInstanceSettings, useSetAllowPrivateHosts } from "@/lib/api/access";

export const Route = createFileRoute("/_app/settings/general")({
	staticData: { crumb: "General" },
	component: General,
});

const DOMAIN_BASE: Record<string, string> = {
	sslip: "sslip.io",
	nip: "nip.io",
	traefik_me: "traefik.me",
	custom: "Custom wildcard",
};

function Row({
	label,
	children,
	mono,
}: {
	label: string;
	children: React.ReactNode;
	mono?: boolean;
}) {
	return (
		<div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd
				className={
					mono ? "min-w-0 truncate font-mono text-sm" : "min-w-0 text-sm"
				}
			>
				{children}
			</dd>
		</div>
	);
}

function General() {
	const { data: s, isPending } = useInstanceSettings();
	const setAllow = useSetAllowPrivateHosts();
	const [confirming, setConfirming] = useState(false);

	const apply = (allow: boolean) =>
		setAllow.mutate(allow, {
			onSuccess: () => {
				setConfirming(false);
				toast(allow ? "Private hosts allowed" : "Private hosts refused again");
			},
			onError: (err) =>
				toast.error("Couldn't change the setting", {
					description: err.message,
				}),
		});

	return (
		<Page className="max-w-3xl">
			<PageHeader
				title="General"
				description="Your organization and the values this instance was set up with."
			/>
			<div className="grid gap-8">
				<Panel id="instance" title="Instance">
					{isPending || !s ? (
						<SkeletonRows rows={5} />
					) : (
						<dl className="divide-y">
							<Row label="Organization">{s.organizationName}</Row>
							<Row label="Instance URL" mono>
								{s.publicUrl ?? "Not set"}
							</Row>
							<Row label="Let's Encrypt email" mono>
								{s.letsencryptEmail ?? "Not set"}
							</Row>
							<Row label="Generated domains">
								{DOMAIN_BASE[s.generatedDomainBase] ?? s.generatedDomainBase}
							</Row>
							<Row label="Local registry">
								{s.localRegistryEnabled ? "On" : "Off"}
							</Row>
						</dl>
					)}
				</Panel>

				<Panel id="network" title="Network safety">
					<div className="flex items-start justify-between gap-6 p-4">
						<div className="min-w-0">
							<label htmlFor="allow-private" className="text-sm font-medium">
								Allow private hosts
							</label>
							<p
								id="allow-private-msg"
								className="mt-1 max-w-[60ch] text-sm text-pretty text-muted-foreground"
							>
								When LogiStack checks a Git repository, a registry or any other
								address someone typed, it refuses private, loopback, link-local
								and cloud metadata addresses, so a form can't be used to probe
								your network. Turn this on only when your registries or Git
								servers live on a private network.
							</p>
						</div>
						<Switch
							id="allow-private"
							aria-describedby="allow-private-msg"
							checked={s?.allowPrivateHosts ?? false}
							disabled={!s || setAllow.isPending}
							onCheckedChange={(on) =>
								on ? setConfirming(true) : apply(false)
							}
						/>
					</div>
				</Panel>
			</div>

			<Dialog open={confirming} onOpenChange={setConfirming}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Allow private hosts?</DialogTitle>
						<DialogDescription>
							Anyone who can create a service could then make this server
							connect to addresses inside your network, such as 10.0.0.0/8 or
							169.254.169.254. Every check is still written to the audit log.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="ghost"
							onClick={() => setConfirming(false)}
							autoFocus
						>
							Keep refusing
						</Button>
						<Button
							variant="destructive"
							onClick={() => apply(true)}
							disabled={setAllow.isPending}
						>
							Allow private hosts
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Page>
	);
}
