import {
	NetworkBlocking,
	type NetworkDevice,
	NetworkDeviceAddress,
	type NetworkPerson,
} from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useState,
} from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import {
	BLOCKLISTS,
	listName,
	PERSONAL_BLOCKLISTS,
} from "@/components/network/presets";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	type DeviceDraft,
	effectiveBlocking,
	hasBlocking,
	networkPeopleApi,
	type PersonDraft,
	peopleQuery,
	useNetworkPeopleMutation,
} from "@/lib/api/network-people";
import { cn } from "@/lib/utils";

const NONE = { listUrls: [], blocked: [] } satisfies NetworkBlocking;

/** API messages are lowercase fragments; forms show sentences. */
const sentence = (m: string) =>
	`${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.?!]$/.test(m) ? "" : "."}`;

/** "Hagezi NSFW, tiktok.com and 1 more", or null when there is nothing extra. */
export function blockingSummary(b: NetworkBlocking, max = 2) {
	const parts = [
		...b.listUrls.map((u) => listName(u) ?? "a custom list"),
		...b.blocked,
	];
	if (!parts.length) return null;
	const shown = parts.slice(0, max).join(", ");
	return parts.length > max ? `${shown} and ${parts.length - max} more` : shown;
}

/** Table cell text for extra blocking: the summary, or a quiet "House lists only". */
export function BlockingCell({ b }: { b: NetworkBlocking }) {
	const s = blockingSummary(b);
	return s ? (
		<span className="block truncate text-xs" title={s}>
			{s}
		</span>
	) : (
		<span className="text-xs text-muted-foreground">House lists only</span>
	);
}

/** Add-on-Enter field that never submits the dialog's form. */
function AddField({
	id,
	label,
	placeholder,
	action,
	onAdd,
}: {
	id: string;
	label: string;
	placeholder: string;
	action: string;
	/** Returns an error message, or nothing when the entry was added. */
	onAdd: (value: string) => string | undefined;
}) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string>();
	const add = () => {
		if (!value.trim()) return;
		const err = onAdd(value.trim());
		if (err) setError(err);
		else setValue("");
	};
	return (
		<div className="grid gap-1.5">
			<div className="flex gap-2">
				<Input
					id={id}
					value={value}
					onChange={(e) => {
						setValue(e.target.value);
						setError(undefined);
					}}
					onKeyDown={(e: KeyboardEvent) => {
						if (e.key !== "Enter") return;
						e.preventDefault();
						add();
					}}
					placeholder={placeholder}
					aria-label={label}
					aria-invalid={error ? true : undefined}
					aria-describedby={`${id}-msg`}
					spellCheck={false}
					autoCapitalize="none"
					autoComplete="off"
					className="font-mono"
				/>
				<Button type="button" variant="outline" onClick={add}>
					{action}
				</Button>
			</div>
			<p
				id={`${id}-msg`}
				className={error ? "text-xs text-bad-text" : "sr-only"}
				aria-live="polite"
			>
				{error}
			</p>
		</div>
	);
}

const SUGGESTED = [...PERSONAL_BLOCKLISTS, BLOCKLISTS[2]];

/** Extra block lists and domains, on top of the house's. */
export function BlockingEditor({
	value,
	onChange,
	inherited,
}: {
	value: NetworkBlocking;
	onChange: (b: NetworkBlocking) => void;
	/** Rules that already come from the device's person, shown so they aren't added twice. */
	inherited?: { from: string; blocking: NetworkBlocking };
}) {
	const uid = useId();
	const suggestions = SUGGESTED.filter(
		(l) =>
			!value.listUrls.includes(l.url) &&
			!inherited?.blocking.listUrls.includes(l.url),
	);
	const addEntry =
		(kind: "listUrls" | "blocked") =>
		(raw: string): string | undefined => {
			const parsed = NetworkBlocking.safeParse(
				kind === "listUrls"
					? { listUrls: [raw], blocked: [] }
					: { listUrls: [], blocked: [raw] },
			);
			if (!parsed.success)
				return kind === "listUrls"
					? "Enter an http or https address of a hosts file or domain list."
					: "Enter a domain like example.com.";
			const v = parsed.data[kind][0] ?? raw;
			if (value[kind].includes(v)) return "Already on the list.";
			onChange({ ...value, [kind]: [...value[kind], v] });
			return undefined;
		};
	const inheritedSummary = inherited && blockingSummary(inherited.blocking, 6);
	return (
		<div className="grid grid-cols-[minmax(0,1fr)] gap-5">
			{inheritedSummary && (
				<p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-pretty text-muted-foreground dark:bg-muted/40">
					Also blocked through{" "}
					<span className="font-medium text-foreground">{inherited.from}</span>:{" "}
					{inheritedSummary}.
				</p>
			)}
			<fieldset className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
				<legend className="mb-1 text-sm font-medium">Block lists</legend>
				{value.listUrls.length > 0 && (
					<ul className="divide-y rounded-lg ring-1 ring-border">
						{value.listUrls.map((u) => (
							<li
								key={u}
								className="flex items-center gap-3 py-1.5 pr-1.5 pl-3"
							>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm">
										{listName(u) ?? "Custom list"}
									</p>
									<p className="truncate font-mono text-xs text-muted-foreground">
										{u}
									</p>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={`Remove ${listName(u) ?? u}`}
									onClick={() =>
										onChange({
											...value,
											listUrls: value.listUrls.filter((x) => x !== u),
										})
									}
								>
									<X />
								</Button>
							</li>
						))}
					</ul>
				)}
				{suggestions.length > 0 && (
					<div className="flex flex-wrap gap-2">
						{suggestions.map((l) => (
							<Button
								key={l.url}
								type="button"
								variant="outline"
								size="sm"
								title={l.description}
								onClick={() =>
									onChange({ ...value, listUrls: [...value.listUrls, l.url] })
								}
							>
								<Plus data-icon="inline-start" />
								{l.name}
							</Button>
						))}
					</div>
				)}
				<AddField
					id={`${uid}-list`}
					label="Block list address"
					placeholder="https://example.com/blocklist.txt"
					action="Add list"
					onAdd={addEntry("listUrls")}
				/>
			</fieldset>
			<fieldset className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
				<legend className="mb-1 text-sm font-medium">Domains</legend>
				<p className="-mt-1 text-xs text-muted-foreground">
					Each one blocks its subdomains too.
				</p>
				{value.blocked.length > 0 && (
					<ul className="flex flex-wrap gap-1.5" aria-label="Blocked domains">
						{value.blocked.map((d) => (
							<li
								key={d}
								className="flex items-center gap-0.5 rounded-md bg-muted py-0.5 pr-0.5 pl-2 font-mono text-xs"
							>
								{d}
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label={`Remove ${d}`}
									className="size-6"
									onClick={() =>
										onChange({
											...value,
											blocked: value.blocked.filter((x) => x !== d),
										})
									}
								>
									<X />
								</Button>
							</li>
						))}
					</ul>
				)}
				<AddField
					id={`${uid}-domain`}
					label="Domain to block"
					placeholder="tiktok.com"
					action="Block"
					onAdd={addEntry("blocked")}
				/>
			</fieldset>
			<p className="text-xs text-pretty text-muted-foreground">
				Added to the house's lists, never instead of them. The first extra rule
				installs Technitium's Advanced Blocking app in the background, which can
				take a few minutes.
			</p>
		</div>
	);
}

/** Creates or edits a person: a name to group devices under, with optional extra blocking. */
export function PersonDialog({
	open,
	onOpenChange,
	person,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	person: NetworkPerson | null;
	onSave: (p: PersonDraft) => Promise<unknown>;
}) {
	const uid = useId();
	const [name, setName] = useState("");
	const [blocking, setBlocking] = useState<NetworkBlocking>(NONE);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!open) return;
		setName(person?.name ?? "");
		setBlocking(person?.blocking ?? NONE);
		setErrors({});
	}, [open, person]);

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!name.trim()) {
			setErrors({ name: "Enter a name." });
			return;
		}
		setBusy(true);
		try {
			await onSave({ name: name.trim(), blocking });
			onOpenChange(false);
		} catch (err) {
			setErrors({
				form: sentence(err instanceof Error ? err.message : String(err)),
			});
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
			<DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
				<form
					onSubmit={submit}
					noValidate
					className="grid grid-cols-[minmax(0,1fr)] gap-5"
				>
					<DialogHeader>
						<DialogTitle>{person ? "Edit person" : "Add person"}</DialogTitle>
						<DialogDescription>
							A name to group devices under. People don't sign in.
						</DialogDescription>
					</DialogHeader>
					<Field id={`${uid}-name`} label="Name" error={errors.name}>
						<Input
							id={`${uid}-name`}
							value={name}
							onChange={(e) => {
								setName(e.target.value);
								setErrors({});
							}}
							placeholder="Luca"
							maxLength={80}
							autoFocus
							autoComplete="off"
							aria-invalid={errors.name ? true : undefined}
							aria-describedby={`${uid}-name-msg`}
						/>
					</Field>
					<BlockingEditor value={blocking} onChange={setBlocking} />
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
							{person ? "Save person" : "Add person"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

const NO_ONE = "none";

/** Creates or edits a device; `address` prefills a new one (naming an IP from the stats or the log). */
export function DeviceDialog({
	open,
	onOpenChange,
	device,
	address: initialAddress,
	people,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	device: NetworkDevice | null;
	address?: string;
	people: NetworkPerson[];
	onSave: (d: DeviceDraft) => Promise<unknown>;
}) {
	const uid = useId();
	const [name, setName] = useState("");
	const [address, setAddress] = useState("");
	const [personId, setPersonId] = useState<string | null>(null);
	const [blocking, setBlocking] = useState<NetworkBlocking>(NONE);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!open) return;
		setName(device?.name ?? "");
		setAddress(device?.address ?? initialAddress ?? "");
		setPersonId(device?.personId ?? null);
		setBlocking(device?.blocking ?? NONE);
		setErrors({});
	}, [open, device, initialAddress]);

	const person = people.find((p) => p.id === personId);
	const effective = effectiveBlocking(blocking, person?.blocking);

	async function submit(e: FormEvent) {
		e.preventDefault();
		const next: Record<string, string> = {};
		if (!name.trim()) next.name = "Enter a name.";
		if (!NetworkDeviceAddress.safeParse(address.trim()).success)
			next.address = "Enter an IP address like 192.168.1.40.";
		setErrors(next);
		if (Object.keys(next).length) return;
		setBusy(true);
		try {
			await onSave({
				name: name.trim(),
				address: address.trim(),
				personId,
				blocking,
			});
			onOpenChange(false);
		} catch (err) {
			setErrors({
				form: sentence(err instanceof Error ? err.message : String(err)),
			});
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
			<DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
				<form
					onSubmit={submit}
					noValidate
					className="grid grid-cols-[minmax(0,1fr)] gap-5"
				>
					<DialogHeader>
						<DialogTitle>
							{device ? "Edit device" : "Name a device"}
						</DialogTitle>
						<DialogDescription>
							The home DNS knows a device by the address it asks from.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 sm:grid-cols-2">
						<Field id={`${uid}-name`} label="Name" error={errors.name}>
							<Input
								id={`${uid}-name`}
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Luca's iPad"
								maxLength={80}
								autoFocus
								autoComplete="off"
								aria-invalid={errors.name ? true : undefined}
								aria-describedby={`${uid}-name-msg`}
							/>
						</Field>
						<Field id={`${uid}-person`} label="Person">
							<Select
								value={personId ?? NO_ONE}
								onValueChange={(v) => setPersonId(v === NO_ONE ? null : v)}
							>
								<SelectTrigger id={`${uid}-person`} className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NO_ONE}>No one</SelectItem>
									{people.map((p) => (
										<SelectItem key={p.id} value={p.id}>
											{p.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					</div>
					<Field
						id={`${uid}-address`}
						label="IP address"
						error={errors.address}
						hint="Give the device a fixed IP or a DHCP reservation on your router; if its address changes, these rules stop matching it."
					>
						<Input
							id={`${uid}-address`}
							value={address}
							onChange={(e) => setAddress(e.target.value)}
							placeholder="192.168.1.40"
							spellCheck={false}
							autoComplete="off"
							className="max-w-56 font-mono tabular-nums"
							aria-invalid={errors.address ? true : undefined}
							aria-describedby={`${uid}-address-msg`}
						/>
					</Field>
					<BlockingEditor
						value={blocking}
						onChange={setBlocking}
						inherited={
							person && { from: person.name, blocking: person.blocking }
						}
					/>
					<p
						className={cn(
							"border-t pt-4 text-sm text-pretty",
							!hasBlocking(effective) && "text-muted-foreground",
						)}
					>
						{hasBlocking(effective)
							? `In all, this device blocks the house's lists plus ${blockingSummary(effective, 6)}.`
							: "This device gets the house's lists only."}
					</p>
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
							{device ? "Save device" : "Add device"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Names an unknown client IP from the stats or the query log: `open(ip)` shows the device
 * dialog prefilled with it; render `dialog` once on the page.
 */
export function useNameDevice() {
	const [address, setAddress] = useState<string | null>(null);
	const { data: people = [] } = useQuery({
		...peopleQuery,
		enabled: address !== null,
	});
	const add = useNetworkPeopleMutation(networkPeopleApi.addDevice);
	const dialog = (
		<DeviceDialog
			open={address !== null}
			onOpenChange={(o) => !o && setAddress(null)}
			device={null}
			address={address ?? undefined}
			people={people}
			onSave={(d) =>
				add
					.mutateAsync(d)
					.then((saved) =>
						toast.success(`${saved.address} is now ${saved.name}`),
					)
			}
		/>
	);
	return { open: setAddress, dialog };
}
