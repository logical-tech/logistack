import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import {
	ConfigFields,
	type ConfigSchema,
	type ConfigValues,
	initialValues,
	missingFields,
	toConfig,
} from "@/components/integrations/config-form";
import { DataChip } from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { ChoiceGroup, Summary, TestPanel } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { api } from "@/lib/api";
import {
	type DnsKind,
	type DnsZone,
	schemasQuery,
	useInvalidating,
} from "@/lib/api/networking";
import { DNS_KINDS } from "@/lib/integrations";
import { usePluginChoices } from "@/lib/plugin-providers";
import { stepParam } from "@/lib/search";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/integrations/dns_/new")({
	staticData: { crumb: "Connect DNS provider" },
	validateSearch: z.object({ step: stepParam }),
	component: NewDnsProvider,
});

type V = {
	/** The radio value: a built-in kind, or a plugin provider's key. */
	kind: string;
	credentials: ConfigValues;
	zones: string[];
	name: string;
};

const DEFAULTS: V = {
	kind: "cloudflare",
	credentials: {},
	zones: [],
	name: "",
};

function ZonePicker({
	zones,
	selected,
	onChange,
}: {
	zones: DnsZone[];
	selected: string[];
	onChange: (ids: string[]) => void;
}) {
	const all = zones.length > 0 && selected.length === zones.length;
	const toggle = (id: string) =>
		onChange(
			selected.includes(id)
				? selected.filter((x) => x !== id)
				: [...selected, id],
		);
	return (
		<fieldset className="grid gap-3">
			<legend className="sr-only">Zones</legend>
			<div className="flex items-center justify-between text-sm">
				<span className="text-muted-foreground">
					<span className="tabular text-foreground">{selected.length}</span> of{" "}
					<span className="tabular">{zones.length}</span> selected
				</span>
				<button
					type="button"
					className="text-sm font-medium underline-offset-4 hover:underline"
					onClick={() => onChange(all ? [] : zones.map((z) => z.id))}
				>
					{all ? "Clear" : "Select all"}
				</button>
			</div>
			<ul className="grid gap-2 sm:grid-cols-2">
				{zones.map((z) => {
					const on = selected.includes(z.id);
					return (
						<li key={z.id}>
							<label
								className={cn(
									"flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3.5 py-3 ring-1 ring-border t-press",
									"has-focus-visible:ring-2 has-focus-visible:ring-ring",
									on && "ring-2 ring-foreground",
								)}
							>
								<input
									type="checkbox"
									className="peer sr-only"
									checked={on}
									onChange={() => toggle(z.id)}
								/>
								<span
									aria-hidden
									className={cn(
										"grid size-4 shrink-0 place-items-center rounded-[5px] ring-1 ring-input transition-colors duration-(--duration-quick)",
										on && "bg-foreground text-background ring-foreground",
									)}
								>
									<Check
										className={cn(
											"size-3 scale-50 opacity-0 transition-[scale,opacity] duration-(--duration-fast) ease-(--ease-smooth-out)",
											on && "scale-100 opacity-100",
										)}
										strokeWidth={3}
									/>
								</span>
								<span className="truncate font-mono text-sm">{z.name}</span>
							</label>
						</li>
					);
				})}
			</ul>
		</fieldset>
	);
}

function NewDnsProvider() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: schemas } = useQuery(schemasQuery);
	const [found, setFound] = useState<DnsZone[]>([]);
	const create = useInvalidating(api.networking.dns.create, [
		["dns-providers"],
	]);

	const fromPlugins = usePluginChoices<DnsKind>("dnsProviders");
	const { resolve } = fromPlugins;
	const schemaOf = useCallback(
		(value: string) => {
			const { kind, plugin } = resolve(value);
			return plugin
				? plugin.schema
				: (schemas?.dns[kind] as ConfigSchema | undefined);
		},
		[schemas, resolve],
	);
	const meta = useCallback(
		(value: string) => {
			const { kind, plugin } = resolve(value);
			const k = DNS_KINDS[kind];
			return { ...k, kind, plugin, label: plugin?.title ?? k.label };
		},
		[resolve],
	);

	const steps = useMemo((): WizardStep<V>[] => {
		const credentials = (v: V) => {
			const s = schemaOf(v.kind);
			return s ? toConfig(s, v.credentials) : {};
		};
		return [
			{
				id: "kind",
				title: "Where does the zone live?",
				description:
					"LogiStack creates records there and solves DNS-01 challenges, so wildcard certificates issue without opening port 80.",
				render: (w) => (
					<ChoiceGroup
						label="DNS provider"
						columns={1}
						value={w.values.kind}
						onChange={(kind) => {
							w.set("kind", kind);
							const s = schemaOf(kind);
							w.set("credentials", s ? initialValues(s) : {});
							w.set("zones", []);
						}}
						choices={[
							...(Object.keys(DNS_KINDS) as DnsKind[])
								.filter((k) => k !== "plugin")
								.map((k) => ({
									value: k as string,
									title: DNS_KINDS[k].label,
									description: DNS_KINDS[k].blurb,
									icon: DNS_KINDS[k].icon,
								})),
							...fromPlugins.choices,
						]}
					/>
				),
			},
			{
				id: "credentials",
				title: "Credentials",
				description:
					"Use a credential limited to DNS on the zones LogiStack should manage. It is encrypted at rest and never shown again.",
				schema: (v) =>
					z.object({ credentials: z.any() }).superRefine((_, ctx) => {
						const s = schemaOf(v.kind);
						if (s && Object.keys(missingFields(s, v.credentials)).length)
							ctx.addIssue({
								code: "custom",
								path: ["credentials"],
								message: "Fill in the required fields.",
							});
					}),
				render: (w) => {
					const s = schemaOf(w.values.kind);
					const kind = meta(w.values.kind);
					if (!s) return null;
					return (
						<div className="grid gap-6">
							<ConfigFields
								schema={s}
								idPrefix="wz-cred"
								values={w.values.credentials}
								onChange={(c) => w.set("credentials", c)}
								errors={
									w.error("credentials")
										? missingFields(s, w.values.credentials)
										: {}
								}
							/>
							<p className="max-w-[62ch] text-sm text-muted-foreground">
								<span className="font-medium text-foreground">
									Where to get it.
								</span>{" "}
								{kind.where}
							</p>
						</div>
					);
				},
			},
			{
				id: "test",
				title: "Test the connection",
				description:
					"LogiStack verifies the credential and lists the zones it can edit. Nothing is changed at the provider.",
				testKeys: ["kind", "credentials"],
				test: async (v) => {
					try {
						const m = meta(v.kind);
						const { zones } = await api.networking.dns.test(
							m.kind,
							credentials(v),
							m.plugin?.ref,
						);
						setFound(zones);
						return zones.length
							? {
									ok: true,
									message: `Connected to ${m.label}`,
									detail: `${zones.length} zone${zones.length === 1 ? "" : "s"} visible: ${zones
										.slice(0, 3)
										.map((z) => z.name)
										.join(", ")}${zones.length > 3 ? "…" : ""}`,
								}
							: {
									ok: false,
									message: "The credential works but sees no zones",
									detail:
										"Give it access to at least one zone, then test again.",
								};
					} catch (err) {
						return {
							ok: false,
							message: "The provider refused the credential",
							detail: err instanceof Error ? err.message : String(err),
						};
					}
				},
				render: (w) => (
					<TestPanel
						w={w}
						idle={`We'll sign in to ${meta(w.values.kind).label} with these credentials and list your zones.`}
					/>
				),
			},
			{
				id: "zones",
				title: "Zones to manage",
				description:
					"Domains in these zones get records and DNS-01 certificates automatically. Others stay untouched.",
				schema: z.object({
					zones: z.array(z.string()).min(1, "Pick at least one zone."),
				}),
				render: (w) => (
					<div className="grid gap-2">
						<ZonePicker
							zones={found}
							selected={w.values.zones.filter((id) =>
								found.some((z) => z.id === id),
							)}
							onChange={(ids) => {
								w.set("zones", ids);
								const first = found.find((z) => z.id === ids[0]);
								if (!w.values.name && first)
									w.set("name", `${meta(w.values.kind).label} · ${first.name}`);
							}}
						/>
						{w.error("zones") && (
							<p className="text-xs text-bad-text" role="alert">
								{w.error("zones")}
							</p>
						)}
					</div>
				),
			},
			{
				id: "name",
				title: "Name it",
				description:
					"Shown wherever you pick a provider. Name it after the account or client.",
				schema: z.object({
					name: z.string().trim().min(1, "Give the provider a name.").max(100),
				}),
				render: (w) => (
					<div className="grid max-w-md gap-4">
						<Field id="wz-name" label="Name" error={w.error("name")}>
							<Input
								{...w.bind("name")}
								autoFocus
								placeholder="Cloudflare · logical.it"
							/>
						</Field>
					</div>
				),
			},
			{
				id: "review",
				title: "Review and connect",
				description: "Credentials are checked once more as they are saved.",
				render: (w) => (
					<Summary
						w={w}
						sections={[
							{
								stepId: "kind",
								title: "Provider",
								rows: [
									{ label: "Kind", value: meta(w.values.kind).label },
									{ label: "Name", value: w.values.name },
								],
							},
							{
								stepId: "zones",
								title: "Zones",
								rows: [
									{
										label: "Managed",
										value: (
											<span className="flex flex-wrap gap-1.5">
												{found
													.filter((z) => w.values.zones.includes(z.id))
													.map((z) => (
														<DataChip key={z.id}>{z.name}</DataChip>
													))}
											</span>
										),
									},
								],
							},
						]}
					/>
				),
			},
		];
	}, [schemaOf, meta, found, fromPlugins.choices]);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	if (!schemas) return null;

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Connect a DNS provider"
				description="Records and certificates for your own domains, without copying values between dashboards."
			/>
			<Wizard
				id="dns-provider"
				steps={steps}
				defaultValues={{
					...DEFAULTS,
					credentials: initialValues(schemas.dns.cloudflare as ConfigSchema),
				}}
				secretKeys={["credentials"]}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Connect provider"
				onComplete={async (v) => {
					const s = schemaOf(v.kind);
					const m = meta(v.kind);
					const p = await create.mutateAsync({
						kind: m.kind,
						name: v.name.trim(),
						credentials: s ? toConfig(s, v.credentials) : {},
						zones: found.filter((z) => v.zones.includes(z.id)),
						...m.plugin?.ref,
					});
					toast.success(`${p.name} connected`, {
						description: `${p.zones.length} zone${p.zones.length === 1 ? "" : "s"} managed.`,
					});
					await navigate({ to: "/integrations/dns" });
				}}
			/>
		</Page>
	);
}
