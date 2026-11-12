import {
	type DnsRecordType,
	type DnsValueParts,
	dnsValueParts,
	formatDnsValue,
	type HomeDnsRecord,
	HomeDnsRecordInput,
	type HomeDnsRecordType,
	homeDnsRecordTypes,
	parseDnsValue,
} from "@logistack/contracts";
import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { formatTtl, relativeName } from "@/components/dns/record-editor";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** A PTR's content is a target name, which is a CNAME's shape. */
const shape = (t: HomeDnsRecordType): DnsRecordType =>
	t === "PTR" ? "CNAME" : t;

const PART: Record<string, { label: string; placeholder: string }> = {
	priority: { label: "Priority", placeholder: "10" },
	weight: { label: "Weight", placeholder: "5" },
	port: { label: "Port", placeholder: "631" },
	text: { label: "Content", placeholder: "v=spf1 -all" },
};
const ADDRESS: Record<
	HomeDnsRecordType,
	{ label: string; placeholder: string }
> = {
	A: { label: "IPv4 address", placeholder: "192.168.1.80" },
	AAAA: { label: "IPv6 address", placeholder: "fd00::80" },
	CNAME: { label: "Target", placeholder: "nas.home.lan" },
	MX: { label: "Mail server", placeholder: "mail.home.lan" },
	SRV: { label: "Target", placeholder: "printer.home.lan" },
	PTR: { label: "Host name", placeholder: "nas.home.lan" },
	TXT: { label: "Content", placeholder: "" },
};
const COLUMNS: Partial<Record<HomeDnsRecordType, string>> = {
	MX: "grid-cols-[5.5rem_minmax(0,1fr)]",
	SRV: "grid-cols-[4.5rem_4.5rem_5rem_minmax(0,1fr)] max-sm:grid-cols-3 max-sm:[&>*:last-child]:col-span-3",
};
const DEFAULTS: Partial<Record<HomeDnsRecordType, DnsValueParts>> = {
	MX: { priority: "10" },
	SRV: { priority: "0", weight: "5" },
};
const TTLS = [60, 300, 900, 3600, 14_400, 86_400];

function absoluteName(input: string, zone: string) {
	const n = input.trim().toLowerCase().replace(/\.$/, "");
	if (n === "" || n === "@" || n === zone) return zone;
	return n.endsWith(`.${zone}`) ? n : `${n}.${zone}`;
}

/** Adds or edits one record of a home DNS zone; validated with the API's own schema. */
export function RecordDialog({
	open,
	onOpenChange,
	zone,
	record,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	zone: string;
	record: HomeDnsRecord | null;
	onSave: (r: HomeDnsRecordInput) => Promise<unknown>;
}) {
	const uid = useId();
	const [type, setType] = useState<HomeDnsRecordType>("A");
	const [name, setName] = useState("");
	const [parts, setParts] = useState<DnsValueParts>({});
	const [ttl, setTtl] = useState(3600);
	const [comment, setComment] = useState("");
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!open) return;
		const t = record?.type ?? "A";
		setType(t);
		setName(record ? relativeName(record.name, zone) : "");
		setParts(
			record ? parseDnsValue(shape(t), record.content) : { ...DEFAULTS[t] },
		);
		setTtl(record?.ttl ?? 3600);
		setComment(record?.comment ?? "");
		setErrors({});
	}, [open, record, zone]);

	async function submit(e: FormEvent) {
		e.preventDefault();
		const parsed = HomeDnsRecordInput.safeParse({
			name: absoluteName(name, zone),
			type,
			content: formatDnsValue(shape(type), parts),
			ttl,
			comment: comment.trim() || undefined,
		});
		if (!parsed.success) {
			setErrors(
				Object.fromEntries(
					parsed.error.issues.map((i) => [String(i.path[0]), i.message]),
				),
			);
			return;
		}
		setBusy(true);
		try {
			await onSave(parsed.data);
			onOpenChange(false);
		} catch (err) {
			setErrors({ form: err instanceof Error ? err.message : String(err) });
		} finally {
			setBusy(false);
		}
	}

	const keys = dnsValueParts[shape(type)];
	const ttlOptions = TTLS.includes(ttl)
		? TTLS
		: [...TTLS, ttl].sort((a, b) => a - b);

	return (
		<Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
			<DialogContent className="sm:max-w-xl">
				<form onSubmit={submit} noValidate className="grid gap-5">
					<DialogHeader>
						<DialogTitle>{record ? "Edit record" : "Add record"}</DialogTitle>
						<DialogDescription>
							Answered by the home DNS to devices in the house. Nothing changes
							on the public internet.
						</DialogDescription>
					</DialogHeader>

					<div className="grid gap-4 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
						<Field id={`${uid}-type`} label="Type">
							<Select
								value={type}
								onValueChange={(t) => {
									const next = t as HomeDnsRecordType;
									setType(next);
									setParts({ ...DEFAULTS[next] });
									setErrors({});
								}}
								disabled={record !== null}
							>
								<SelectTrigger id={`${uid}-type`} className="w-full font-mono">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{homeDnsRecordTypes.map((t) => (
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
							hint={`@ for ${zone} itself.`}
						>
							<InputGroup>
								<InputGroupInput
									id={`${uid}-name`}
									value={name}
									onChange={(e) => setName(e.target.value)}
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
										.{zone}
									</InputGroupText>
								</InputGroupAddon>
							</InputGroup>
						</Field>
					</div>

					<fieldset className="grid gap-1.5">
						<legend className="sr-only">Value</legend>
						<div
							className={cn(
								"grid min-w-0 gap-2",
								COLUMNS[type] ?? "grid-cols-1",
							)}
						>
							{keys.map((key) => {
								const meta =
									key === "address" || key === "target"
										? ADDRESS[type]
										: (PART[key] ?? { label: key, placeholder: "" });
								const shared = {
									id: `${uid}-${key}`,
									value: parts[key] ?? "",
									placeholder: meta.placeholder,
									spellCheck: false,
									autoComplete: "off",
									"aria-invalid": errors.content ? true : undefined,
									"aria-describedby": `${uid}-content-msg`,
								} as const;
								return (
									<div key={key} className="min-w-0">
										<label
											htmlFor={shared.id}
											className="mb-1.5 block text-xs text-muted-foreground"
										>
											{meta.label}
										</label>
										{type === "TXT" ? (
											<Textarea
												{...shared}
												onChange={(e) =>
													setParts((p) => ({ ...p, [key]: e.target.value }))
												}
												rows={3}
												className="min-h-20 font-mono text-[13px] break-all"
											/>
										) : (
											<Input
												{...shared}
												onChange={(e) =>
													setParts((p) => ({ ...p, [key]: e.target.value }))
												}
												autoCapitalize="none"
												className="font-mono tabular-nums"
											/>
										)}
									</div>
								);
							})}
						</div>
						<p
							id={`${uid}-content-msg`}
							className={cn(
								"text-xs text-bad-text",
								!errors.content && "sr-only",
							)}
							aria-live="polite"
						>
							{errors.content?.replace(/^\w+: /, "")}
						</p>
					</fieldset>

					<div className="grid gap-4 sm:grid-cols-2">
						<Field
							id={`${uid}-ttl`}
							label="TTL"
							hint="How long devices may cache it."
						>
							<Select
								value={String(ttl)}
								onValueChange={(v) => setTtl(Number(v))}
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
											{formatTtl(t)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
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
								placeholder="Synology in the closet"
								maxLength={200}
							/>
						</Field>
					</div>

					{errors.form && (
						<p className="text-sm text-bad-text" role="alert">
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
