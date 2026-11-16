import { type HomeProxy, HomeProxyEnableInput } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	Fingerprint,
	Route as RouteIcon,
	ServerCog,
	ShieldCheck,
} from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { TLS_LABEL } from "@/components/network/home-proxy";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChoiceGroup, Instructions, Summary } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import {
	homeProxyApi,
	useHomeProxy,
	useHomeProxyMutation,
} from "@/lib/api/home-proxy";
import { type DnsProvider, dnsProvidersQuery } from "@/lib/api/networking";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/network_/proxy_/new")({
	staticData: { crumb: "Set up local proxy" },
	validateSearch: z.object({ step: stepParam }),
	component: SetUpLocalProxy,
});

type V = { zone: string; tls: "acme" | "internal" };

const normal = (zone: string) => zone.trim().toLowerCase().replace(/\.$/, "");

/** A provider of this organization holding the zone; the server also checks other organizations'. */
const holder = (providers: DnsProvider[], zone: string) => {
	const z = normal(zone);
	for (const p of providers) {
		const hit = p.zones.find((x) => z === x.name || z.endsWith(`.${x.name}`));
		if (hit) return { name: p.name, zone: hit.name };
	}
	return undefined;
};

function buildSteps(
	proxy: HomeProxy | undefined,
	providers: DnsProvider[],
): WizardStep<V>[] {
	return [
		{
			id: "zone",
			title: "Zone",
			description:
				"The domain the names live under. Each device gets a name in it, like nas.home.example.com.",
			schema: z.object({
				zone: z
					.string()
					.refine(
						(v) => HomeProxyEnableInput.shape.zone.safeParse(v).success,
						"Enter a domain name such as home.example.com.",
					),
			}),
			render: (w) => (
				<div className="grid max-w-xl gap-6">
					<Field id="wz-zone" label="Zone" error={w.error("zone")}>
						<Input
							{...w.bind("zone")}
							placeholder="home.example.com"
							spellCheck={false}
							autoCapitalize="none"
							className="max-w-xs font-mono"
							autoFocus
						/>
					</Field>
					<Instructions>
						<p>
							Use a subdomain of a domain you own, like{" "}
							<strong>home.example.com</strong>. Then Let's Encrypt can issue a
							certificate every browser trusts, while the names still resolve
							only inside the house. A made-up name like home.lan works only
							with the internal certificate authority.
						</p>
					</Instructions>
				</div>
			),
		},
		{
			id: "certificate",
			title: "Certificate",
			description:
				"One certificate covers every name in the zone, so adding a route never waits for a new one.",
			render: (w) => {
				const zone = normal(w.values.zone);
				const p = holder(providers, zone);
				return (
					<div className="grid gap-6">
						<ChoiceGroup
							label="Certificate"
							value={w.values.tls}
							onChange={(t) => w.set("tls", t)}
							choices={[
								{
									value: "acme",
									title: TLS_LABEL.acme,
									description: `A certificate for *.${zone} that every device trusts. Needs a DNS provider holding the zone.`,
									icon: ShieldCheck,
									badge: "Recommended",
								},
								{
									value: "internal",
									title: TLS_LABEL.internal,
									description:
										"Signed by the proxy itself. Works for any name, but each device must trust its root certificate.",
									icon: Fingerprint,
								},
							]}
						/>
						{w.values.tls === "acme" ? (
							<Instructions>
								<p>
									LogiStack proves it controls the zone with a temporary TXT
									record (DNS-01), so Let's Encrypt never connects to this
									server. Nothing is published: no A record, no open port.
								</p>
								<p>
									{p ? (
										<>
											<strong>{p.name}</strong> holds {p.zone} and will solve
											the challenge.
										</>
									) : (
										<>
											A connected DNS provider must hold {zone}.{" "}
											<Link to="/integrations/dns" className="underline">
												DNS providers
											</Link>
										</>
									)}
								</p>
							</Instructions>
						) : (
							<Instructions>
								<p>
									<strong>
										Browsers warn on every name until a device trusts the root
										certificate.
									</strong>{" "}
									After setup you can download it from the local proxy page and
									install it on each phone, laptop and tablet.
								</p>
							</Instructions>
						)}
					</div>
				);
			},
		},
		{
			id: "review",
			title: "Review",
			description:
				"Turning it on changes nothing on the internet. Add routes for your devices next.",
			render: (w) => {
				const zone = normal(w.values.zone);
				return (
					<div className="grid gap-6">
						<Summary
							w={w}
							sections={[
								{
									stepId: "zone",
									title: "Zone",
									rows: [
										{
											label: "Names",
											value: <span className="font-mono">*.{zone}</span>,
										},
									],
								},
								{
									stepId: "certificate",
									title: "Certificate",
									rows: [
										{ label: "Issued by", value: TLS_LABEL[w.values.tls] },
										...(w.values.tls === "acme"
											? [
													{
														label: "DNS provider",
														value:
															holder(providers, zone)?.name ??
															"Checked when you turn it on",
													},
												]
											: []),
									],
								},
							]}
						/>
						<Instructions>
							{proxy?.automaticRecords ? (
								<p>
									The home DNS points every name in {zone} at{" "}
									<strong>{proxy.lanAddress}</strong>. No router change needed.
								</p>
							) : (
								<p>
									<strong>One step on your side:</strong> point{" "}
									<span className="font-mono">*.{zone}</span> at this server's
									address on your network, in your router's DNS. The local proxy
									page shows the record.
								</p>
							)}
						</Instructions>
					</div>
				);
			},
		},
	];
}

function SetUpLocalProxy() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: proxy, admin, me } = useHomeProxy();
	const { data: providers } = useQuery({
		...dnsProvidersQuery,
		enabled: admin,
	});
	const enable = useHomeProxyMutation(homeProxyApi.enable);
	const steps = useMemo(
		() => buildSteps(proxy, providers ?? []),
		[proxy, providers],
	);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	// Opened while it was already on; turning it on from here navigates away.
	const alreadyOn = useRef<boolean>(undefined);
	if (proxy && alreadyOn.current === undefined)
		alreadyOn.current = proxy.enabled;

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Set up local proxy"
				description="HTTPS names with a valid certificate for devices in the house: the NAS, the router, Home Assistant. Reachable only from your network."
			/>
			{me && !admin ? (
				<EmptyState
					icon={ServerCog}
					title="Only instance admins manage the local proxy"
					description="It belongs to the whole server, not to an organization. Ask an instance admin to add you."
				/>
			) : !proxy ? (
				<Panel title="Loading" id="wizard-loading">
					<SkeletonRows rows={3} />
				</Panel>
			) : alreadyOn.current ? (
				<EmptyState
					icon={RouteIcon}
					title="The local proxy is already on"
					description={`Names answer under ${proxy.zone}. Change the zone or certificate from its page.`}
				>
					<Button asChild>
						<Link to="/network/proxy">Open local proxy</Link>
					</Button>
				</EmptyState>
			) : (
				<Wizard
					id="home-proxy"
					steps={steps}
					defaultValues={{ zone: "", tls: "acme" as const }}
					step={step}
					onStepChange={onStepChange}
					finishLabel="Turn on"
					onComplete={async (v) => {
						await enable.mutateAsync({ zone: normal(v.zone), tls: v.tls });
						toast.success("Local proxy is on", {
							description: "Add a route for each device.",
						});
						await navigate({ to: "/network/proxy" });
					}}
				/>
			)}
		</Page>
	);
}
