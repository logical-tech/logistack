import {
	type DnsRecordType,
	type DnsValueParts,
	dnsRecordSetIssues,
	dnsRecordTypes,
	dnsTtlRules,
	dnsValueParts,
	formatDnsValue,
	parseDnsValue,
	proxiableTypes,
} from "@logistack/contracts";
import { Cloud, Loader2, Minus, Plus, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
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
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { DnsKind, DnsRecordSet, DnsZone } from "@/lib/api/networking";
import { cn } from "@/lib/utils";

/** Cloudflare's own orange, kept to the proxy cloud so the toggle reads the way it does in their dashboard. */
export const CLOUD_ORANGE = "text-[#f6821f]";

const PART: Record<
	string,
	{ label: string; placeholder: string; numeric?: boolean }
> = {
	priority: { label: "Priority", placeholder: "10", numeric: true },
	weight: { label: "Weight", placeholder: "5", numeric: true },
	port: { label: "Port", placeholder: "443", numeric: true },
	flags: { label: "Flags", placeholder: "0", numeric: true },
	tag: { label: "Tag", placeholder: "issue" },
	value: { label: "Value", placeholder: "letsencrypt.org" },
	text: {
		label: "Content",
		placeholder: "v=spf1 include:_spf.example.com ~all",
	},
};

const ADDRESS: Partial<
	Record<DnsRecordType, { label: string; placeholder: string }>
> = {
	A: { label: "IPv4 address", placeholder: "203.0.113.10" },
	AAAA: { label: "IPv6 address", placeholder: "2001:db8::1" },
	CNAME: { label: "Target", placeholder: "app.example.net" },
	NS: { label: "Name server", placeholder: "ns1.example.net" },
	MX: { label: "Mail server", placeholder: "mx1.example.com" },
	SRV: { label: "Target", placeholder: "sip.example.com" },
};

const partMeta = (
	type: DnsRecordType,
	key: string,
): { label: string; placeholder: string; numeric?: boolean } =>
	key === "address" || key === "target"
		? (ADDRESS[type] ?? { label: "Value", placeholder: "" })
		: (PART[key] ?? { label: key, placeholder: "" });

/** Column widths per type: numbers stay narrow, the host or text takes the rest. */
const COLUMNS: Partial<Record<DnsRecordType, string>> = {
	MX: "grid-cols-[5.5rem_minmax(0,1fr)]",
	SRV: "grid-cols-[4.5rem_4.5rem_5rem_minmax(0,1fr)] max-sm:grid-cols-3 max-sm:[&>*:last-child]:col-span-3",
	CAA: "grid-cols-[4.5rem_8.5rem_minmax(0,1fr)]",
};

const CAA_TAGS = [
	{ value: "issue", label: "issue" },
	{ value: "issuewild", label: "issuewild" },
	{ value: "iodef", label: "iodef" },
];

const DEFAULT_PARTS: Partial<Record<DnsRecordType, DnsValueParts>> = {
	MX: { priority: "10" },
	SRV: { priority: "10", weight: "5" },
	CAA: { flags: "0", tag: "issue" },
};
const blank = (type: DnsRecordType): DnsValueParts => ({
	...DEFAULT_PARTS[type],
});

const PRESETS = [
	60, 120, 300, 600, 900, 1800, 3600, 7200, 18_000, 43_200, 86_400,
];

export function formatTtl(ttl: number, kind?: DnsKind) {
	if (kind && ttl === dnsTtlRules[kind]?.auto) return "Auto";
	if (ttl % 86_400 === 0)
		return `${ttl / 86_400} day${ttl === 86_400 ? "" : "s"}`;
	if (ttl % 3600 === 0) return `${ttl / 3600} h`;
	if (ttl % 60 === 0 && ttl > 0) return `${ttl / 60} min`;
	return `${ttl} s`;
}

/** `www` from `www.example.com`, `@` for the apex. */
export function relativeName(name: string, zone: string) {
	if (name === zone) return "@";
	return name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name;
}

function absoluteName(input: string, zone: string) {
	const n = input.trim().toLowerCase().replace(/\.$/, "");
	if (n === "" || n === "@" || n === zone) return zone;
	return n.endsWith(`.${zone}`) ? n : `${n}.${zone}`;
}

const KIND_LABEL: Record<DnsKind, string> = {
	cloudflare: "Cloudflare",
	route53: "Route 53",
	hetzner: "Hetzner",
	digitalocean: "DigitalOcean",
	ovh: "OVHcloud",
	porkbun: "Porkbun",
	plugin: "the plugin",
};

type Errors = Record<string, string>;

/** Creates or edits one record set. Fields follow the type; the proxy toggle and comment are Cloudflare's. */
export function RecordEditor({
	open,
	onOpenChange,
	kind,
	zone,
	record,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	kind: DnsKind;
	zone: DnsZone;
	/** Edits this set; creates a new one when absent. */
	record: DnsRecordSet | null;
	onSave: (body: {
		name: string;
		type: DnsRecordType;
		ttl: number;
		values: string[];
		proxied?: boolean;
		comment?: string;
	}) => Promise<unknown>;
}) {
	const uid = useId();
	const cf = kind === "cloudflare";
	const auto = dnsTtlRules[kind]?.auto;
	const defaultTtl = auto ?? Math.max(300, dnsTtlRules[kind]?.min ?? 0);
	const multi = !cf;

	const [type, setType] = useState<DnsRecordType>("A");
	const [name, setName] = useState("");
	const [values, setValues] = useState<DnsValueParts[]>([blank("A")]);
	const [ttl, setTtl] = useState(defaultTtl);
	const [proxied, setProxied] = useState(false);
	const [comment, setComment] = useState("");
	const [errors, setErrors] = useState<Errors>({});
	const [busy, setBusy] = useState(false);

	// Reset to the record (or a blank form) each time the dialog opens.
	useEffect(() => {
		if (!open) return;
		const t = record?.type ?? "A";
		setType(t);
		setName(record ? relativeName(record.name, zone.name) : "");
		setValues(
			record ? record.values.map((v) => parseDnsValue(t, v)) : [blank(t)],
		);
		setTtl(record?.ttl ?? defaultTtl);
		setProxied(record?.proxied ?? false);
		setComment(record?.comment ?? "");
		setErrors({});
	}, [open, record, zone.name, defaultTtl]);

	const proxiable = cf && proxiableTypes.includes(type);
	const isProxied = proxiable && proxied;
	const canAddValue = multi && type !== "CNAME" && values.length < 100;
	const ttlOptions = [
		...(auto !== undefined ? [auto] : []),
		...PRESETS.filter(
			(p) =>
				p >= (dnsTtlRules[kind]?.min ?? 0) &&
				p <= (dnsTtlRules[kind]?.max ?? p),
		),
	];
	if (!ttlOptions.includes(ttl)) ttlOptions.push(ttl);
	ttlOptions.sort((a, b) => a - b);

	function changeType(t: DnsRecordType) {
		setType(t);
		setValues([blank(t)]);
		setErrors({});
	}

	function setPart(i: number, key: string, v: string) {
		setValues((vs) => vs.map((p, j) => (j === i ? { ...p, [key]: v } : p)));
		setErrors(({ [`values.${i}.${key}`]: _, ...rest }) => rest);
	}

	async function submit(e: FormEvent) {
		e.preventDefault();
		const body = {
			name: absoluteName(name, zone.name),
			type,
			ttl: isProxied && auto !== undefined ? auto : ttl,
			values: values.map((p) => formatDnsValue(type, p)),
			...(proxiable ? { proxied } : {}),
			...(cf ? { comment: comment.trim() } : {}),
		};
		const issues = dnsRecordSetIssues(kind, zone.name, body);
		if (issues.length) {
			setErrors(Object.fromEntries(issues.reverse()));
			return;
		}
		setBusy(true);
		try {
			await onSave(body);
			onOpenChange(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setErrors({ form: message });
		} finally {
			setBusy(false);
		}
	}

	const parts = dnsValueParts[type];
	const fieldId = (i: number, key: string) => `${uid}-v${i}-${key}`;

	return (
		<Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
			<DialogContent className="sm:max-w-xl">
				<form onSubmit={submit} noValidate className="grid gap-5">
					<DialogHeader>
						<DialogTitle>{record ? "Edit record" : "Add record"}</DialogTitle>
						<DialogDescription>
							Saved straight to {KIND_LABEL[kind]}. Resolvers pick up the change
							within the record's TTL.
						</DialogDescription>
					</DialogHeader>

					{record?.domain && (
						<p className="flex gap-2 rounded-lg bg-muted/70 px-3 py-2.5 text-sm text-muted-foreground">
							<TriangleAlert
								className="mt-0.5 size-4 shrink-0 text-warn-text"
								aria-hidden
							/>
							<span>
								LogiStack created this record for{" "}
								<span className="font-medium text-foreground">
									{record.domain.hostname}
								</span>
								. Pointing it elsewhere takes that domain offline.
							</span>
						</p>
					)}

					<div className="grid gap-4 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
						<Field id={`${uid}-type`} label="Type">
							<Select
								value={type}
								onValueChange={(t) => changeType(t as DnsRecordType)}
								disabled={record !== null}
							>
								<SelectTrigger id={`${uid}-type`} className="w-full font-mono">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{dnsRecordTypes.map((t) => (
										<SelectItem key={t} value={t} className="font-mono">
											{t}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<Field
							id={`${uid}-name`}
							label="Name"
							error={errors.name}
							hint={`@ for ${zone.name} itself, * for a wildcard.`}
						>
							<InputGroup>
								<InputGroupInput
									id={`${uid}-name`}
									value={name}
									onChange={(e) => {
										setName(e.target.value);
										setErrors(({ name: _, ...rest }) => rest);
									}}
									placeholder="@"
									autoFocus
									autoCapitalize="none"
									autoComplete="off"
									spellCheck={false}
									className="font-mono"
									aria-invalid={errors.name ? true : undefined}
									aria-describedby={`${uid}-name-msg`}
								/>
								<InputGroupAddon align="inline-end">
									<InputGroupText className="max-w-40 truncate font-mono font-normal">
										.{zone.name}
									</InputGroupText>
								</InputGroupAddon>
							</InputGroup>
						</Field>
					</div>

					<fieldset className="grid gap-2">
						<legend className="mb-2 text-sm font-medium">
							{values.length > 1 ? "Values" : "Value"}
						</legend>
						{values.map((p, i) => {
							const rowErrors = parts
								.map((k) => errors[`values.${i}.${k}`])
								.filter(Boolean);
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: values have no identity of their own
								<div key={i} className="grid gap-1.5">
									<div className="flex items-start gap-2">
										<div
											className={cn(
												"grid min-w-0 flex-1 gap-2",
												COLUMNS[type] ?? "grid-cols-1",
											)}
										>
											{parts.map((key) => {
												const meta = partMeta(type, key);
												const id = fieldId(i, key);
												const invalid = Boolean(errors[`values.${i}.${key}`]);
												const label = (
													<label
														htmlFor={id}
														className={cn(
															"mb-1.5 block text-xs text-muted-foreground",
															i > 0 && "sr-only",
														)}
													>
														{meta.label}
														{values.length > 1 && i > 0 && `, value ${i + 1}`}
													</label>
												);
												if (type === "CAA" && key === "tag")
													return (
														<div key={key} className="min-w-0">
															{label}
															<Select
																value={p.tag ?? "issue"}
																onValueChange={(v) => setPart(i, key, v)}
															>
																<SelectTrigger
																	id={id}
																	className="w-full font-mono"
																>
																	<SelectValue />
																</SelectTrigger>
																<SelectContent>
																	{CAA_TAGS.map((t) => (
																		<SelectItem
																			key={t.value}
																			value={t.value}
																			className="font-mono"
																		>
																			{t.label}
																		</SelectItem>
																	))}
																</SelectContent>
															</Select>
														</div>
													);
												const shared = {
													id,
													value: p[key] ?? "",
													placeholder: meta.placeholder,
													spellCheck: false,
													autoComplete: "off",
													"aria-invalid": invalid || undefined,
													"aria-describedby": `${uid}-v${i}-msg`,
												} as const;
												return (
													<div key={key} className="min-w-0">
														{label}
														{type === "TXT" ? (
															<Textarea
																{...shared}
																onChange={(e) =>
																	setPart(i, key, e.target.value)
																}
																rows={3}
																className="min-h-20 font-mono text-[13px] break-all"
															/>
														) : (
															<Input
																{...shared}
																onChange={(e) =>
																	setPart(i, key, e.target.value)
																}
																inputMode={meta.numeric ? "numeric" : undefined}
																autoCapitalize="none"
																className="font-mono tabular-nums"
															/>
														)}
													</div>
												);
											})}
										</div>
										{values.length > 1 && (
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												className={cn(
													"shrink-0",
													i === 0 && "mt-[1.375rem]",
													type === "TXT" ? "self-start" : "",
												)}
												aria-label={`Remove value ${i + 1}`}
												onClick={() =>
													setValues((vs) => vs.filter((_, j) => j !== i))
												}
											>
												<Minus />
											</Button>
										)}
									</div>
									<p
										id={`${uid}-v${i}-msg`}
										className={cn(
											"text-xs text-bad-text",
											!rowErrors.length && "sr-only",
										)}
										aria-live="polite"
									>
										{rowErrors.join(" · ")}
									</p>
								</div>
							);
						})}
						{errors.values && (
							<p className="text-xs text-bad-text">{errors.values}</p>
						)}
						{canAddValue && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="w-fit"
								onClick={() => setValues((vs) => [...vs, blank(type)])}
							>
								<Plus data-icon="inline-start" />
								Add value
							</Button>
						)}
					</fieldset>

					<div className="grid gap-4 sm:grid-cols-2">
						<Field
							id={`${uid}-ttl`}
							label="TTL"
							error={errors.ttl}
							hint={
								isProxied
									? "Proxied records always use Auto."
									: kind === "hetzner"
										? "Hetzner accepts 60 seconds or more."
										: "How long resolvers may cache the answer."
							}
						>
							<Select
								value={String(isProxied && auto !== undefined ? auto : ttl)}
								onValueChange={(v) => setTtl(Number(v))}
								disabled={isProxied}
							>
								<SelectTrigger
									id={`${uid}-ttl`}
									className="w-full tabular-nums"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ttlOptions.map((t) => (
										<SelectItem key={t} value={String(t)}>
											{formatTtl(t, kind)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						{cf && (
							<Field
								id={`${uid}-comment`}
								label="Comment"
								optional
								error={errors.comment}
							>
								<Input
									id={`${uid}-comment`}
									value={comment}
									onChange={(e) => setComment(e.target.value)}
									maxLength={100}
									placeholder="What this record is for"
									autoComplete="off"
								/>
							</Field>
						)}
					</div>

					{proxiable && (
						<label
							htmlFor={`${uid}-proxied`}
							className="flex cursor-pointer items-start gap-3 rounded-lg bg-muted/60 px-3.5 py-3"
						>
							<Cloud
								className={cn(
									"mt-0.5 size-4.5 shrink-0 transition-colors duration-(--duration-quick)",
									proxied ? CLOUD_ORANGE : "text-muted-foreground",
								)}
								fill={proxied ? "currentColor" : "none"}
								aria-hidden
							/>
							<span className="grid flex-1 gap-0.5">
								<span className="text-sm font-medium">
									Proxy through Cloudflare
								</span>
								<span className="text-xs text-muted-foreground">
									{proxied
										? "Visitors reach Cloudflare, which hides the origin address and caches."
										: "DNS only: the record answers with this value directly."}
								</span>
							</span>
							<Switch
								id={`${uid}-proxied`}
								checked={proxied}
								onCheckedChange={setProxied}
								className="mt-0.5"
							/>
						</label>
					)}
					{errors.proxied && (
						<p className="text-xs text-bad-text">{errors.proxied}</p>
					)}

					{errors.form && (
						<p
							className="rounded-lg bg-bad/10 px-3 py-2.5 text-sm text-bad-text"
							role="alert"
						>
							{errors.form}
						</p>
					)}

					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
							disabled={busy}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={busy}>
							{busy && <Loader2 className="animate-spin" />}
							{record ? "Save record" : "Add record"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
