import type { HomeDnsSettings } from "@logistack/contracts";
import { Cloud, Shield, Sparkles, Wrench } from "lucide-react";
import { Field } from "@/components/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup } from "@/components/wizard/parts";
import { PROTOCOLS, UPSTREAMS, upstreamPreset } from "./presets";

type Upstream = HomeDnsSettings["upstream"];
export type UpstreamDraft = {
	preset: string;
	protocol: Upstream["protocol"];
	/** Custom servers, one per line, in Technitium's format. */
	servers: string;
};

export const fromUpstream = (u: Upstream): UpstreamDraft => ({
	preset: upstreamPreset(u)?.id ?? "custom",
	protocol: u.protocol,
	servers: u.servers.join("\n"),
});

export const toUpstream = (d: UpstreamDraft): Upstream =>
	UPSTREAMS.find((p) => p.id === d.preset)?.upstream ?? {
		protocol: d.protocol,
		servers: d.servers
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean),
	};

/** Why a custom upstream can't be saved, or undefined when it can. */
export function upstreamIssue(d: UpstreamDraft) {
	if (d.preset !== "custom") return undefined;
	const servers = toUpstream(d).servers;
	if (!servers.length) return "Enter at least one server.";
	if (servers.length > 8) return "Up to 8 servers.";
	if (servers.some((s) => s.includes(",")))
		return "One server per line, without commas.";
	return undefined;
}

const ICONS = { cloudflare: Cloud, quad9: Shield, google: Sparkles };

export function UpstreamFields({
	value,
	onChange,
	error,
	idPrefix,
}: {
	value: UpstreamDraft;
	onChange: (v: UpstreamDraft) => void;
	error?: string;
	idPrefix: string;
}) {
	return (
		<div className="grid gap-4">
			<ChoiceGroup
				label="Upstream resolver"
				value={value.preset}
				onChange={(preset) => onChange({ ...value, preset })}
				choices={[
					...UPSTREAMS.map((u, i) => ({
						value: u.id,
						title: u.name,
						description: u.description,
						icon: ICONS[u.id as keyof typeof ICONS],
						badge: i === 0 ? "Default" : undefined,
					})),
					{
						value: "custom",
						title: "Custom",
						description: "Your own resolvers over HTTPS, TLS or plain DNS.",
						icon: Wrench,
					},
				]}
			/>
			{value.preset === "custom" && (
				<div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
					<Field id={`${idPrefix}-protocol`} label="Protocol">
						<Select
							value={value.protocol}
							onValueChange={(p) =>
								onChange({ ...value, protocol: p as Upstream["protocol"] })
							}
						>
							<SelectTrigger id={`${idPrefix}-protocol`} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(PROTOCOLS).map(([k, label]) => (
									<SelectItem key={k} value={k}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<Field
						id={`${idPrefix}-servers`}
						label="Servers"
						error={error}
						hint={
							value.protocol === "Https"
								? "One per line: https://dns.example/dns-query (203.0.113.1)"
								: value.protocol === "Tls"
									? "One per line: dns.example (203.0.113.1:853)"
									: "One IP address per line."
						}
					>
						<Textarea
							id={`${idPrefix}-servers`}
							value={value.servers}
							onChange={(e) => onChange({ ...value, servers: e.target.value })}
							rows={3}
							spellCheck={false}
							aria-invalid={error ? true : undefined}
							aria-describedby={`${idPrefix}-servers-msg`}
							className="font-mono text-[13px]"
						/>
					</Field>
				</div>
			)}
		</div>
	);
}
