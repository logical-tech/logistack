import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Cable } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { Page, PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Summary } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import {
	type DnsProvider,
	dnsProvidersQuery,
	useInvalidating,
} from "@/lib/api/networking";
import { cloudflareAccountsQuery, tunnelsApi } from "@/lib/api/tunnels";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/integrations/tunnels_/new")({
	staticData: { crumb: "Create tunnel" },
	validateSearch: z.object({ step: stepParam }),
	component: NewTunnel,
});

type V = {
	dnsProviderId: string;
	accountId: string;
	accountName: string;
	name: string;
};

function AccountStep({ w }: { w: WizardApi<V> }) {
	const { data, isPending, error } = useQuery(
		cloudflareAccountsQuery(w.values.dnsProviderId),
	);
	const { set } = w;
	const only = data?.length === 1 ? data[0] : undefined;
	// One account is the common case: pick it so Next is one click.
	useEffect(() => {
		if (!only) return;
		set("accountId", only.id);
		set("accountName", only.name);
	}, [only, set]);
	if (isPending)
		return (
			<p className="text-sm text-muted-foreground">
				Asking Cloudflare which accounts the token can see…
			</p>
		);
	if (error)
		return (
			<div className="grid gap-2 text-sm">
				<p className="text-bad-text">{error.message}</p>
				<p className="text-muted-foreground">
					The provider's API token needs{" "}
					<span className="text-foreground">
						Account › Cloudflare Tunnel › Edit
					</span>{" "}
					and{" "}
					<span className="text-foreground">
						Account › Account Settings › Read
					</span>{" "}
					on top of Zone › DNS › Edit. Edit the token at Cloudflare, then come
					back.
				</p>
			</div>
		);
	return (
		<Field id="wz-accountId" label="Account" error={w.error("accountId")}>
			<Select
				value={w.values.accountId}
				onValueChange={(id) => {
					set("accountId", id);
					set("accountName", data?.find((a) => a.id === id)?.name ?? "");
				}}
			>
				<SelectTrigger id="wz-accountId" className="w-full max-w-md">
					<SelectValue placeholder="Pick an account" />
				</SelectTrigger>
				<SelectContent>
					{data?.map((a) => (
						<SelectItem key={a.id} value={a.id}>
							{a.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</Field>
	);
}

function buildSteps(providers: DnsProvider[]): WizardStep<V>[] {
	const cloudflare = providers.filter((p) => p.kind === "cloudflare");
	return [
		{
			id: "provider",
			title: "Cloudflare provider",
			description:
				"The tunnel reuses a connected Cloudflare DNS provider's token, and serves hostnames in its zones.",
			schema: z.object({
				dnsProviderId: z.string().min(1, "Pick a provider."),
			}),
			render: (w) =>
				cloudflare.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No Cloudflare provider is connected.{" "}
						<Link
							to="/integrations/dns/new"
							className="text-foreground underline underline-offset-4"
						>
							Connect Cloudflare
						</Link>{" "}
						first, with a token that can also edit tunnels.
					</p>
				) : (
					<Field
						id="wz-dnsProviderId"
						label="Provider"
						error={w.error("dnsProviderId")}
					>
						<Select
							value={w.values.dnsProviderId}
							onValueChange={(id) => {
								w.set("dnsProviderId", id);
								w.set("accountId", "");
							}}
						>
							<SelectTrigger id="wz-dnsProviderId" className="w-full max-w-md">
								<SelectValue placeholder="Pick a provider" />
							</SelectTrigger>
							<SelectContent>
								{cloudflare.map((p) => (
									<SelectItem key={p.id} value={p.id}>
										{p.name} · {p.zones.map((z) => z.name).join(", ")}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
				),
		},
		{
			id: "account",
			title: "Account",
			description: "Tunnels belong to a Cloudflare account, not to a zone.",
			schema: z.object({ accountId: z.string().min(1, "Pick an account.") }),
			render: (w) => <AccountStep w={w} />,
		},
		{
			id: "name",
			title: "Name",
			description: "How the tunnel appears here and in Cloudflare's dashboard.",
			schema: z.object({
				name: z.string().trim().min(1, "Name the tunnel.").max(60),
			}),
			render: (w) => (
				<Field id="wz-name" label="Name" error={w.error("name")}>
					<Input
						{...w.bind("name")}
						placeholder="homelab"
						className="max-w-md"
						autoFocus
					/>
				</Field>
			),
		},
		{
			id: "review",
			title: "Review and create",
			description:
				"LogiStack creates the tunnel at Cloudflare and starts cloudflared in the swarm. It connects within a few seconds.",
			render: (w) => (
				<Summary
					w={w}
					sections={[
						{
							stepId: "provider",
							title: "Cloudflare",
							rows: [
								{
									label: "Provider",
									value:
										cloudflare.find((p) => p.id === w.values.dnsProviderId)
											?.name ?? "",
								},
								{ label: "Account", value: w.values.accountName },
							],
						},
						{
							stepId: "name",
							title: "Tunnel",
							rows: [{ label: "Name", value: w.values.name }],
						},
					]}
				/>
			),
		},
	];
}

function NewTunnel() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: providers } = useQuery(dnsProvidersQuery);
	const create = useInvalidating(tunnelsApi.create, [["tunnels"]]);
	const steps = useMemo(() => buildSteps(providers ?? []), [providers]);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	if (!providers) return null;
	const first = providers.find((p) => p.kind === "cloudflare");
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Create a Cloudflare Tunnel"
				description="Expose services through Cloudflare without opening ports on this server."
			/>
			<Wizard
				id="tunnel-new"
				steps={steps}
				defaultValues={{
					dnsProviderId: first?.id ?? "",
					accountId: "",
					accountName: "",
					name: "",
				}}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Create tunnel"
				onComplete={async (v) => {
					await create.mutateAsync({
						dnsProviderId: v.dnsProviderId,
						accountId: v.accountId,
						name: v.name.trim(),
					});
					toast.success(`${v.name} created`, {
						description: "cloudflared is starting; it shows Connected shortly.",
						icon: <Cable className="size-4" />,
					});
					await navigate({ to: "/integrations/tunnels" });
				}}
			/>
		</Page>
	);
}
