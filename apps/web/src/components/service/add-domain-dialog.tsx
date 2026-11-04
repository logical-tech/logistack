import { Hostname } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Cable, Globe, Loader2, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ChoiceGroup } from "@/components/wizard/parts";
import { api } from "@/lib/api";
import { type DomainBody, useInvalidating } from "@/lib/api/networking";
import type { ServiceOverview } from "@/lib/api/service-ops";
import { tunnelsQuery } from "@/lib/api/tunnels";

type Exposure = "public" | "tunnel";

/** The port a domain most likely wants: the HTTP healthcheck's, else the first published one. */
export function defaultPort(o: ServiceOverview | undefined): number {
	const spec = o?.spec;
	if (spec?.kind !== "application") return 80;
	if (spec.healthcheck?.type === "http") return spec.healthcheck.port;
	return spec.ports[0]?.target ?? 80;
}

/** Waits for typing to settle before asking the API which provider owns the zone. */
function useSettled(value: string, ms = 400) {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return settled;
}

/**
 * The quick path from a service's Domains tab: hostname, port, and how it is exposed. A
 * managed zone gets its record and a DNS-01 certificate; anything finer goes to the wizard.
 */
export function AddDomainDialog({
	service,
	open,
	onOpenChange,
}: {
	service: ServiceOverview;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [hostname, setHostname] = useState("");
	const [port, setPort] = useState(() => String(defaultPort(service)));
	const [exposure, setExposure] = useState<Exposure>("public");
	const [error, setError] = useState<string | null>(null);
	const host = hostname.trim().toLowerCase();
	const valid = Hostname.safeParse(host).success;
	const settled = useSettled(valid ? host : "");
	const { data: match, isFetching } = useQuery({
		queryKey: ["dns-match", service.id, settled],
		queryFn: () => api.networking.dns.match(service.id, settled),
		enabled: Boolean(settled),
		staleTime: 30_000,
	});
	const { data: tunnels } = useQuery(tunnelsQuery);
	const zone = settled === host ? match?.match : undefined;
	const tunnel =
		zone && tunnels?.find((t) => t.dnsProviderId === zone.providerId);
	const create = useInvalidating(
		(body: DomainBody) => api.networking.domains.create(service.id, body),
		[["domains"], ["dns-providers"], ["tunnels"]],
	);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!tunnel && exposure === "tunnel") setExposure("public");
	}, [tunnel, exposure]);
	useEffect(() => {
		if (!open) {
			setHostname("");
			setError(null);
		}
	}, [open]);

	const submit = async () => {
		const p = Number(port);
		if (!valid) return setError("Use a hostname like app.example.com.");
		if (!Number.isInteger(p) || p < 1 || p > 65535)
			return setError("Ports run from 1 to 65535.");
		if (host.startsWith("*.") && !zone)
			return setError(
				"A wildcard needs a zone managed by a connected DNS provider.",
			);
		setError(null);
		setBusy(true);
		try {
			let body: DomainBody;
			if (exposure === "tunnel" && zone) {
				body = {
					hostname: host,
					port: p,
					https: false,
					cert: "none",
					dnsProviderId: zone.providerId,
					tunnel: true,
				};
			} else if (zone && match?.publicIp) {
				const ip = match.publicIp;
				const record = await api.networking.dns.upsertRecord(service.id, {
					dnsProviderId: zone.providerId,
					hostname: host,
					type: ip.includes(":") ? "AAAA" : "A",
					content: ip,
					proxied: false,
				});
				body = {
					hostname: host,
					port: p,
					https: true,
					cert: "auto",
					dnsProviderId: zone.providerId,
					dnsRecordId: record.id,
				};
			} else {
				body = { hostname: host, port: p, https: true, cert: "auto" };
			}
			await create.mutateAsync(body);
			toast.success(`${host} added`, {
				description:
					exposure === "tunnel"
						? "The tunnel picks it up within a few seconds."
						: zone
							? `Record set at ${zone.providerName}; the certificate follows over DNS-01.`
							: "Point its A record at this server; the certificate follows once it resolves.",
				icon: <Globe className="size-4" />,
			});
			onOpenChange(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add a domain to {service.name}</DialogTitle>
					<DialogDescription>
						The proxy routes the hostname to a port of this service.
					</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-5"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
						<Field id="add-domain-host" label="Hostname">
							<Input
								id="add-domain-host"
								value={hostname}
								onChange={(e) => setHostname(e.target.value)}
								placeholder="app.example.com"
								autoCapitalize="none"
								spellCheck={false}
								autoFocus
								className="font-mono"
							/>
						</Field>
						<Field id="add-domain-port" label="Port">
							<Input
								id="add-domain-port"
								value={port}
								onChange={(e) => setPort(e.target.value)}
								inputMode="numeric"
								className="tabular"
							/>
						</Field>
					</div>
					<p
						className="-mt-2 flex min-h-5 items-center gap-2 text-xs text-muted-foreground"
						aria-live="polite"
					>
						{valid && isFetching && (
							<Loader2 className="size-3 animate-spin" aria-hidden />
						)}
						{zone ? (
							<span>
								<span className="font-mono">{zone.zone.name}</span> is managed
								by <span className="text-foreground">{zone.providerName}</span>:
								the record is created for you.
							</span>
						) : valid && settled === host && !isFetching ? (
							<span>
								No connected provider manages this zone. Point an A record at{" "}
								<span className="font-mono text-foreground">
									{match?.publicIp ?? "this server"}
								</span>
								.
							</span>
						) : null}
					</p>
					{tunnel && (
						<ChoiceGroup
							label="Exposure"
							columns={2}
							value={exposure}
							onChange={setExposure}
							choices={[
								{
									value: "public",
									title: "Public, Let's Encrypt",
									description:
										"This server answers on 443 with its own certificate.",
									icon: Lock,
								},
								{
									value: "tunnel",
									title: "Cloudflare Tunnel",
									description: `Through ${tunnel.name}. No open ports.`,
									icon: Cable,
								},
							]}
						/>
					)}
					{error && (
						<p className="text-sm text-bad-text" role="alert">
							{error}
						</p>
					)}
					<DialogFooter className="items-center sm:justify-between">
						<Button variant="link" size="sm" className="px-0" asChild>
							<Link to="/domains/new" search={{ serviceId: service.id }}>
								Advanced setup
							</Link>
						</Button>
						<Button type="submit" disabled={busy || !valid}>
							{busy && <Loader2 className="animate-spin" />}
							Add domain
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
