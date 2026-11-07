import {
	deploymentContextVars,
	isReservedEnvKey,
	RESERVED_ENV_PREFIX,
} from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
	ChevronsUpDown,
	ClipboardPaste,
	CopyPlus,
	Eye,
	EyeOff,
	Lock,
	Plus,
	Settings2,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { type ClipboardEvent, type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { Panel } from "@/components/panel";
import { ScopeChip } from "@/components/secrets/secrets-panel";
import { Segmented } from "@/components/segmented";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import {
	type AvailableSecret,
	availableSecretsQuery,
	looksSecret,
	SCOPE_LABEL as SECRET_SCOPE_LABEL,
} from "@/lib/api/secrets";
import {
	type EffectiveEnvVar,
	type EnvScope,
	type ServiceVarInput,
	useServiceMutation,
} from "@/lib/api/service-ops";
import type { ProjectId, ServiceId } from "@/lib/api/types";
import { parseDotenv } from "@/lib/dotenv";
import { cn } from "@/lib/utils";

/**
 * One editable variable. `secret` rows reference a managed secret by id; `text` rows carry a
 * typed value, stored as the service's own secret when `isSecret`. `value: null` keeps a
 * stored value this user cannot see.
 */
type Row = {
	uid: string;
	key: string;
	mode: "secret" | "text";
	secretId: string | null;
	value: string | null;
	isSecret: boolean;
	isBuildTime: boolean;
	/** A new row whose Secret toggle follows its name until someone sets it. */
	auto?: boolean;
};

const SCOPE_LABEL: Record<EnvScope, string> = {
	organization: "Organization",
	project: "Project",
	environment: "Environment",
	service: "Service",
};
const RANK: Record<EnvScope, number> = {
	organization: 0,
	project: 1,
	environment: 2,
	service: 3,
};
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOTS = "••••••••••••";

let uidSeq = 0;
const uid = () => `r${uidSeq++}`;
/** What an editor starts from: one stored variable at its scope. */
export type VarLike = Pick<
	EffectiveEnvVar,
	"key" | "value" | "isSecret" | "isBuildTime" | "secretId"
>;
const toRow = (v: VarLike): Row => ({
	uid: uid(),
	key: v.key,
	mode: v.secretId ? "secret" : "text",
	secretId: v.secretId,
	value: v.secretId ? null : v.value,
	isSecret: v.isSecret,
	isBuildTime: v.isBuildTime,
});
/** Content without row ids or order, to compare a draft with the server's set. */
const signature = (rows: Row[]) =>
	JSON.stringify(
		rows
			.map(({ uid: _, auto: __, ...r }) => r)
			.sort((a, b) => a.key.localeCompare(b.key)),
	);

/** A secret reference that no longer resolves for this service. */
const isBroken = (r: Row, available: AvailableSecret[] | undefined) =>
	r.mode === "secret" &&
	r.secretId !== null &&
	available !== undefined &&
	!available.some((a) => a.id === r.secretId);

/** A problem with one row, or null. */
function rowError(
	r: Row,
	rows: Row[],
	initial: Row[],
	available: AvailableSecret[] | undefined,
) {
	if (!r.key) return "Name it";
	if (!KEY.test(r.key))
		return "Letters, digits and _, not starting with a digit";
	if (isReservedEnvKey(r.key))
		return `${RESERVED_ENV_PREFIX} names are set by LogiStack`;
	if (rows.filter((o) => o.key === r.key).length > 1) return "Defined twice";
	if (r.mode === "secret") {
		if (!r.secretId) return "Choose a secret";
		if (isBroken(r, available))
			return "This secret is no longer available to this service. Its project may have moved to another folder.";
		return null;
	}
	const keeps = initial.some(
		(i) =>
			i.key === r.key &&
			i.mode === "text" &&
			i.value === null &&
			i.isSecret === r.isSecret,
	);
	if (r.value === null && !keeps)
		return "Enter a value: the stored one is hidden from you";
	return null;
}

function Toggle({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the checkbox is inside
		<label className="inline-flex items-center gap-2 text-xs text-muted-foreground select-none">
			<Checkbox
				checked={checked}
				onCheckedChange={(v) => onChange(v === true)}
			/>
			{label}
		</label>
	);
}

function Masked() {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					// biome-ignore lint/a11y/noNoninteractiveTabindex: focus shows the tooltip
					tabIndex={0}
					className="inline-flex items-center gap-1.5 rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Lock className="size-3.5" aria-hidden />
					Hidden
				</span>
			</TooltipTrigger>
			<TooltipContent className="max-w-64">
				Seeing secret values needs the Read secrets permission on the scope that
				defines it. You can still replace it.
			</TooltipContent>
		</Tooltip>
	);
}

/** Groups in chain order: organization, each folder, project, environment, service. */
function groupsOf(available: AvailableSecret[]) {
	const groups: { id: string; heading: string; items: AvailableSecret[] }[] =
		[];
	for (const s of available) {
		const id = `${s.scope}:${s.scopeId}`;
		let g = groups.find((x) => x.id === id);
		if (!g) {
			g = {
				id,
				heading: s.scopeName
					? `${SECRET_SCOPE_LABEL[s.scope]} · ${s.scopeName}`
					: SECRET_SCOPE_LABEL[s.scope],
				items: [],
			};
			groups.push(g);
		}
		g.items.push(s);
	}
	return groups;
}

/** A searchable list of the secrets on the service's chain, grouped by where each is defined. */
function SecretPicker({
	row,
	available,
	broken,
	open,
	onOpenChange,
	onPick,
	label,
}: {
	row: Row;
	available: AvailableSecret[] | undefined;
	broken: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onPick: (s: AvailableSecret) => void;
	label: string;
}) {
	const picked = available?.find((a) => a.id === row.secretId);
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					role="combobox"
					aria-expanded={open}
					aria-label={label}
					aria-invalid={broken || undefined}
					className="h-8 w-full justify-between gap-2 px-2.5 font-normal aria-invalid:text-bad-text aria-invalid:ring-1 aria-invalid:ring-destructive/50"
				>
					{picked ? (
						<span className="flex min-w-0 items-center gap-2">
							<Lock className="size-3.5 text-muted-foreground" aria-hidden />
							<span className="truncate font-mono text-[13px]">
								{picked.key}
							</span>
							<ScopeChip
								scope={picked.scope}
								name={picked.scopeName}
								className="hidden min-w-0 shrink sm:inline-flex"
							/>
						</span>
					) : broken ? (
						<span className="flex min-w-0 items-center gap-2">
							<TriangleAlert className="size-3.5" aria-hidden />
							<span className="truncate text-sm">Secret not available</span>
						</span>
					) : (
						<span className="truncate text-sm text-muted-foreground">
							{available ? "Choose a secret" : "Loading secrets…"}
						</span>
					)}
					<ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-(--radix-popover-trigger-width) min-w-80 p-0"
				align="start"
			>
				<Command>
					<CommandInput placeholder="Search secrets" />
					<CommandList className="max-h-80">
						<CommandEmpty>
							{available?.length
								? "No secret matches."
								: "No secrets on this service's chain yet."}
						</CommandEmpty>
						{groupsOf(available ?? []).map((g) => (
							<CommandGroup key={g.id} heading={g.heading}>
								{g.items.map((s) => (
									<CommandItem
										key={s.id}
										value={s.id}
										keywords={[s.key, s.scopeName, s.description ?? ""]}
										data-checked={s.id === row.secretId}
										onSelect={() => onPick(s)}
										className={cn(s.shadowed && "text-muted-foreground")}
									>
										<Lock className="size-3.5 text-muted-foreground" />
										<span
											className={cn(
												"min-w-0 flex-1 truncate font-mono text-[13px]",
												s.shadowed &&
													"line-through decoration-muted-foreground/50",
											)}
										>
											{s.key}
										</span>
										<span className="shrink-0 text-xs text-muted-foreground tabular">
											{s.shadowed ? "shadowed" : `v${s.version}`}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/** Lets the panels after the editor see its draft: which names it defines, and add one. */
export type Draft = {
	keys: Set<string>;
	add: (key: string, value: string) => void;
};

/**
 * The editable set of variables at one scope, with paste-a-.env and a save bar. `save`
 * receives the whole set; an entry without `value` keeps the stored one.
 *
 * With `secrets` (a service), each row is either a reference to a managed secret or typed
 * text, and text marked secret becomes the service's own secret on save. Without it (an
 * organization, project or environment), rows are plain variables.
 */
export function VariablesEditor({
	title,
	id,
	empty,
	vars,
	save,
	savedHint,
	redeploy,
	secrets,
	children,
}: {
	title: string;
	id: string;
	empty: ReactNode;
	vars: VarLike[];
	save: (variables: ServiceVarInput[]) => Promise<unknown>;
	/** The toast after a plain save. */
	savedHint: string;
	/** Adds "Save and redeploy"; runs after the save. */
	redeploy?: () => Promise<unknown>;
	/** Secrets the rows may reference; `{ available: undefined }` while loading. */
	secrets?: { available: AvailableSecret[] | undefined };
	/** Panels rendered between the editor and its save bar. */
	children?: (draft: Draft) => ReactNode;
}) {
	const service = secrets !== undefined;
	const available = secrets?.available;
	const initial = useMemo(() => vars.map(toRow), [vars]);
	const [rows, setRows] = useState<Row[]>(initial);
	const [base, setBase] = useState(() => signature(initial));
	const [revealed, setRevealed] = useState<Set<string>>(new Set());
	const [pasteOpen, setPasteOpen] = useState(false);
	const [pasteText, setPasteText] = useState("");
	const [busy, setBusy] = useState(false);
	const [picking, setPicking] = useState<string | null>(null);
	const [review, setReview] = useState<boolean | null>(null);

	// The server's set changed: take it, unless that would drop edits made since the last sync.
	const incoming = signature(initial);
	const draft = signature(rows);
	if (incoming !== base) {
		if (draft === base || draft === incoming) setRows(initial);
		setBase(incoming);
	}

	const drafted = new Set(rows.map((r) => r.key));
	const errors = rows.map((r) => rowError(r, rows, initial, available));
	const dirty = draft !== incoming;
	const valid = errors.every((e) => e === null);
	/** Typed values this save stores as the service's own secrets. */
	const becomeSecrets = service
		? rows.filter((r) => r.mode === "text" && r.isSecret && r.value !== null)
		: [];

	const update = (id: string, patch: Partial<Row>) =>
		setRows((rs) => rs.map((r) => (r.uid === id ? { ...r, ...patch } : r)));
	const remove = (id: string) =>
		setRows((rs) => rs.filter((r) => r.uid !== id));
	const newRow = (key: string, value: string | null): Row => ({
		uid: uid(),
		key,
		mode: "text",
		secretId: null,
		value,
		isSecret: service && looksSecret(key),
		isBuildTime: false,
		auto: service,
	});
	const add = (key = "", value: string | null = "") =>
		setRows((rs) => [...rs, newRow(key, value)]);
	const setKey = (r: Row, key: string) =>
		update(r.uid, r.auto ? { key, isSecret: looksSecret(key) } : { key });

	/** Pasted assignments replace rows with the same name and append the rest. */
	function merge(text: string, replacing?: string) {
		const { variables, invalid } = parseDotenv(text);
		if (!variables.length) {
			toast.error("Nothing to add", {
				description: "Paste lines of the form KEY=value.",
			});
			return false;
		}
		setRows((rs) => {
			const next = rs.filter((r) => r.uid !== replacing).map((r) => ({ ...r }));
			for (const v of variables) {
				const existing = next.find((r) => r.key === v.key);
				if (existing)
					Object.assign(existing, {
						value: v.value,
						// A pasted value replaces a reference; it stays a secret.
						...(existing.mode === "secret" && {
							mode: "text",
							secretId: null,
							isSecret: true,
						}),
					});
				else next.push(newRow(v.key, v.value));
			}
			return next;
		});
		toast.success(
			`${variables.length} ${variables.length === 1 ? "variable" : "variables"} added`,
			invalid.length
				? { description: `Skipped line ${invalid.join(", ")}: not KEY=value.` }
				: undefined,
		);
		return true;
	}

	function onKeyPaste(e: ClipboardEvent<HTMLInputElement>, row: Row) {
		const text = e.clipboardData.getData("text");
		if (!text.includes("=") || row.key) return;
		e.preventDefault();
		merge(text, row.value ? undefined : row.uid);
	}

	async function submit(andRedeploy: boolean) {
		setReview(null);
		setBusy(true);
		try {
			await save(
				rows.map((r) =>
					r.mode === "secret" && r.secretId
						? {
								key: r.key,
								isSecret: true,
								isBuildTime: r.isBuildTime,
								secretId: r.secretId,
							}
						: {
								key: r.key,
								isSecret: r.isSecret,
								isBuildTime: r.isBuildTime,
								...(r.value === null ? {} : { value: r.value }),
							},
				),
			);
			// The server rewrites typed secrets as references: take its set as it arrives.
			setBase(signature(rows));
			if (andRedeploy && redeploy) await redeploy();
			else toast.success("Variables saved", { description: savedHint });
		} catch (e) {
			toast.error(
				andRedeploy ? "Couldn't save and redeploy" : "Couldn't save",
				{
					description: e instanceof Error ? e.message : undefined,
				},
			);
		} finally {
			setBusy(false);
		}
	}
	/** New service secrets get a summary first (rule 8); everything else saves at once. */
	const requestSave = (andRedeploy: boolean) =>
		becomeSecrets.length ? setReview(andRedeploy) : submit(andRedeploy);

	const reveal = (k: string) =>
		setRevealed((s) => {
			const next = new Set(s);
			if (next.has(k)) next.delete(k);
			else next.add(k);
			return next;
		});

	const preview = pasteText ? parseDotenv(pasteText) : null;
	const plainChanged = rows.filter(
		(r) => r.mode === "text" && !r.isSecret && r.value !== null,
	);

	return (
		<div className="grid gap-8">
			<Panel
				title={title}
				id={id}
				actions={
					<div className="flex gap-1">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setPasteOpen(true)}
						>
							<ClipboardPaste data-icon="inline-start" />
							Paste .env
						</Button>
						<Button variant="ghost" size="sm" onClick={() => add()}>
							<Plus data-icon="inline-start" />
							Add
						</Button>
					</div>
				}
			>
				{rows.length === 0 ? (
					<p className="px-4 py-6 text-sm text-pretty text-muted-foreground">
						{empty}
					</p>
				) : (
					<ul className="divide-y">
						{rows.map((r, i) => {
							const error = errors[i];
							const broken = isBroken(r, available);
							const shown = !r.isSecret || revealed.has(r.uid);
							const name = r.key || `variable ${i + 1}`;
							return (
								<li
									key={r.uid}
									className={cn(
										"grid gap-2 px-4 py-3 md:items-start",
										service
											? "md:grid-cols-[minmax(0,13rem)_auto_minmax(0,1fr)_auto]"
											: "md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]",
									)}
								>
									<div className="min-w-0">
										<input
											value={r.key}
											onChange={(e) => setKey(r, e.target.value.trim())}
											onPaste={(e) => onKeyPaste(e, r)}
											placeholder="NAME"
											aria-label={`Name of variable ${i + 1}`}
											aria-invalid={error && !broken ? true : undefined}
											spellCheck={false}
											autoCapitalize="off"
											// biome-ignore lint/a11y/noAutofocus: focus the row just added
											autoFocus={!r.key && i === rows.length - 1}
											className="h-8 w-full rounded-lg bg-muted/60 px-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring aria-invalid:ring-2 aria-invalid:ring-destructive/40 dark:bg-muted/40"
										/>
										{error && !broken && (
											<p className="mt-1 text-xs text-bad-text">{error}</p>
										)}
									</div>
									{service && (
										<div>
											<Segmented
												label={`Kind of ${name}`}
												value={r.mode}
												onChange={(mode) =>
													update(r.uid, {
														mode,
														auto: false,
														...(mode === "text"
															? { isSecret: true, value: r.value ?? "" }
															: {}),
													})
												}
												options={[
													{ value: "secret", label: "Secret" },
													{ value: "text", label: "Text" },
												]}
											/>
										</div>
									)}
									<div className="min-w-0">
										{r.mode === "secret" ? (
											<SecretPicker
												row={r}
												available={available}
												broken={broken}
												open={picking === r.uid}
												onOpenChange={(o) => setPicking(o ? r.uid : null)}
												label={`Secret for ${name}`}
												onPick={(s) => {
													update(r.uid, {
														secretId: s.id,
														key: r.key || s.key,
														isSecret: true,
													});
													setPicking(null);
												}}
											/>
										) : (
											<div className="relative">
												<input
													type={shown ? "text" : "password"}
													value={r.value ?? ""}
													onChange={(e) =>
														update(r.uid, { value: e.target.value })
													}
													placeholder={
														r.value === null
															? "Hidden. Type to replace it"
															: "value"
													}
													aria-label={`Value of ${name}`}
													spellCheck={false}
													autoComplete="off"
													className="h-8 w-full rounded-lg bg-muted/60 pr-9 pl-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring dark:bg-muted/40"
												/>
												{r.isSecret && r.value !== null && (
													<Button
														variant="ghost"
														size="icon-xs"
														className="absolute top-1 right-1"
														aria-label={shown ? "Hide value" : "Show value"}
														aria-pressed={shown}
														onClick={() => reveal(r.uid)}
													>
														{shown ? <EyeOff /> : <Eye />}
													</Button>
												)}
											</div>
										)}
										{broken && (
											<div className="mt-1.5 flex items-start gap-2 text-xs text-bad-text">
												<p className="min-w-0 flex-1 text-pretty">{error}</p>
												<Button
													variant="outline"
													size="xs"
													className="shrink-0"
													onClick={() => setPicking(r.uid)}
												>
													Fix
												</Button>
											</div>
										)}
									</div>
									<div className="flex h-8 items-center gap-4">
										{service && (
											<span
												className={cn(
													"w-17",
													r.mode === "secret" && "hidden md:block",
												)}
											>
												{r.mode === "text" && (
													<Toggle
														label="Secret"
														checked={r.isSecret}
														onChange={(isSecret) =>
															update(r.uid, { isSecret, auto: false })
														}
													/>
												)}
											</span>
										)}
										<Toggle
											label="Build"
											checked={r.isBuildTime}
											onChange={(isBuildTime) => update(r.uid, { isBuildTime })}
										/>
										<Button
											variant="ghost"
											size="icon-sm"
											className="ml-auto text-muted-foreground"
											aria-label={`Remove ${name}`}
											onClick={() => remove(r.uid)}
										>
											<Trash2 />
										</Button>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</Panel>

			{children?.({ keys: drafted, add: (k, v) => add(k, v) })}

			{dirty && (
				<div className="t-reveal sticky bottom-4 z-20 flex flex-wrap items-center justify-end gap-2 rounded-xl bg-popover px-4 py-3 shadow-float ring-1 ring-border">
					<p
						className="mr-auto text-sm text-muted-foreground"
						aria-live="polite"
					>
						{valid ? "Unsaved changes" : "Fix the marked rows to save"}
					</p>
					<Button
						variant="ghost"
						disabled={busy}
						onClick={() => setRows(initial)}
					>
						Discard
					</Button>
					<Button
						variant={redeploy ? "outline" : "default"}
						disabled={!valid || busy}
						onClick={() => requestSave(false)}
					>
						Save
					</Button>
					{redeploy ? (
						<Button disabled={!valid || busy} onClick={() => requestSave(true)}>
							Save and redeploy
						</Button>
					) : null}
				</div>
			)}

			<Dialog
				open={review !== null}
				onOpenChange={(o) => !o && setReview(null)}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Review before saving</DialogTitle>
						<DialogDescription>
							Values marked secret are stored encrypted as this service's own
							secrets, with a version history. Plain variables are stored as
							typed.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4">
						<SummaryList
							title="Become secrets"
							keys={becomeSecrets.map((r) => r.key)}
							icon
						/>
						{plainChanged.length > 0 && (
							<SummaryList
								title="Stay plain variables"
								keys={plainChanged.map((r) => r.key)}
							/>
						)}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setReview(null)}>
							Back
						</Button>
						<Button disabled={busy} onClick={() => submit(review === true)}>
							{review ? "Save and redeploy" : "Save"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Paste a .env file</DialogTitle>
						<DialogDescription>
							KEY=value lines; comments, quotes and{" "}
							<code className="font-mono">export</code> are understood. Names
							that already exist take the pasted value.
							{service &&
								" Names that look sensitive start as secrets; switch any row before saving."}
						</DialogDescription>
					</DialogHeader>
					<Textarea
						value={pasteText}
						onChange={(e) => setPasteText(e.target.value)}
						rows={9}
						spellCheck={false}
						placeholder={'DATABASE_URL=postgres://…\nexport API_TOKEN="…"'}
						aria-label=".env contents"
						className="font-mono text-[13px]"
					/>
					{preview && (
						<div className="grid gap-2">
							<p className="text-sm text-muted-foreground">
								{preview.variables.length}{" "}
								{preview.variables.length === 1 ? "variable" : "variables"}
								{preview.invalid.length > 0 &&
									`, line ${preview.invalid.join(", ")} skipped`}
							</p>
							{service && preview.variables.length > 0 && (
								<ul className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
									{preview.variables.map((v) => (
										<li key={v.key}>
											<Badge
												variant={looksSecret(v.key) ? "secondary" : "outline"}
												className="font-mono font-normal"
											>
												{looksSecret(v.key) && <Lock aria-label="secret" />}
												{v.key}
											</Badge>
										</li>
									))}
								</ul>
							)}
						</div>
					)}
					<DialogFooter>
						<Button variant="ghost" onClick={() => setPasteOpen(false)}>
							Cancel
						</Button>
						<Button
							disabled={!preview?.variables.length}
							onClick={() => {
								if (merge(pasteText)) {
									setPasteOpen(false);
									setPasteText("");
								}
							}}
						>
							Add {preview?.variables.length || ""} variables
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function SummaryList({
	title,
	keys,
	icon,
}: {
	title: string;
	keys: string[];
	icon?: boolean;
}) {
	return (
		<section>
			<h3 className="mb-1.5 text-sm font-medium">
				{title}{" "}
				<span className="text-muted-foreground tabular">{keys.length}</span>
			</h3>
			<ul className="divide-y overflow-hidden rounded-lg bg-muted/50 dark:bg-muted/30">
				{keys.map((k) => (
					<li key={k} className="flex items-center gap-2 px-3 py-1.5">
						{icon ? (
							<Lock className="size-3.5 text-muted-foreground" aria-hidden />
						) : null}
						<span className="truncate font-mono text-[13px]">{k}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

/** Organization, project and environment variables a service sees, and which of them it overrides. */
function InheritedPanel({
	vars,
	draft,
	projectId,
	environmentId,
}: {
	vars: EffectiveEnvVar[];
	draft: Draft;
	projectId: ProjectId;
	environmentId?: string;
}) {
	const [revealed, setRevealed] = useState<Set<string>>(new Set());
	const reveal = (k: string) =>
		setRevealed((s) => {
			const next = new Set(s);
			if (next.has(k)) next.delete(k);
			else next.add(k);
			return next;
		});
	const inherited = vars.filter((v) => v.scope !== "service");
	const overridden = (v: EffectiveEnvVar) =>
		draft.keys.has(v.key) ||
		inherited.some((o) => o.key === v.key && RANK[o.scope] > RANK[v.scope]);
	return (
		<Panel
			title="Inherited"
			id="inherited-vars"
			actions={
				<Button variant="ghost" size="sm" asChild>
					<Link
						to="/projects/$projectId/variables"
						params={{ projectId }}
						search={{ env: environmentId, tab: "variables" }}
					>
						<Settings2 data-icon="inline-start" />
						Secrets & variables
					</Link>
				</Button>
			}
		>
			{inherited.length === 0 ? (
				<p className="px-4 py-6 text-sm text-muted-foreground">
					No plain variables are set for the organization, project or
					environment.
				</p>
			) : (
				<ul className="divide-y">
					{inherited.map((v) => {
						const off = overridden(v);
						const shown = !v.isSecret || revealed.has(v.id);
						return (
							<li
								key={v.id}
								className={cn(
									"grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_7rem_auto]",
									off && "text-muted-foreground",
								)}
							>
								<span
									className={cn(
										"truncate font-mono text-[13px]",
										off && "line-through decoration-muted-foreground/60",
									)}
									title={
										off
											? `${v.key}: overridden by a more specific scope`
											: v.key
									}
								>
									{v.key}
								</span>
								<span className="col-span-2 row-start-2 flex min-w-0 items-center gap-1 font-mono text-[13px] md:col-span-1 md:row-start-auto">
									{v.value === null ? (
										<Masked />
									) : (
										<>
											<span className={cn("truncate", off && "line-through")}>
												{shown
													? v.value || (
															<span className="text-muted-foreground">
																empty
															</span>
														)
													: DOTS}
											</span>
											{v.isSecret && (
												<Button
													variant="ghost"
													size="icon-xs"
													aria-label={shown ? `Hide ${v.key}` : `Show ${v.key}`}
													aria-pressed={shown}
													onClick={() => reveal(v.id)}
												>
													{shown ? <EyeOff /> : <Eye />}
												</Button>
											)}
										</>
									)}
								</span>
								<Badge
									variant="secondary"
									className="justify-self-end md:justify-self-start"
								>
									{SCOPE_LABEL[v.scope]}
								</Badge>
								<span className="hidden justify-end md:flex">
									<Button
										variant="ghost"
										size="icon-sm"
										className="text-muted-foreground"
										aria-label={`Override ${v.key} for this service`}
										title="Override for this service"
										disabled={draft.keys.has(v.key)}
										onClick={() => draft.add(v.key, v.value ?? "")}
									>
										<CopyPlus />
									</Button>
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}

function ContextPanel() {
	return (
		<Panel title="Set on every deployment" id="context-vars">
			<p className="border-b px-4 py-3 text-sm text-pretty text-muted-foreground">
				Read-only. Containers get these at runtime, and a Dockerfile build gets
				the ones it declares with <code className="font-mono">ARG</code>.
			</p>
			<dl className="divide-y">
				{Object.entries(deploymentContextVars).map(([key, about]) => (
					<div
						key={key}
						className="grid gap-x-3 gap-y-0.5 px-4 py-2.5 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:items-baseline"
					>
						<dt className="truncate font-mono text-[13px]" title={key}>
							{key}
						</dt>
						<dd className="text-sm text-pretty text-muted-foreground">
							{about}
						</dd>
					</div>
				))}
			</dl>
		</Panel>
	);
}

export function EnvEditor({
	serviceId,
	projectId,
	environmentId,
	vars,
}: {
	serviceId: ServiceId;
	projectId: ProjectId;
	environmentId?: string;
	vars: EffectiveEnvVar[];
}) {
	const navigate = useNavigate();
	const own = useMemo(() => vars.filter((v) => v.scope === "service"), [vars]);
	const { data: available } = useQuery(availableSecretsQuery(serviceId));
	const save = useServiceMutation(serviceId, (variables: ServiceVarInput[]) =>
		api.serviceOps.saveEnvVars(serviceId, variables),
	);
	const deploy = useServiceMutation(serviceId, () =>
		api.serviceOps.deploy(serviceId),
	);
	return (
		<VariablesEditor
			title="Service variables"
			id="service-vars"
			empty={
				<>
					None yet. Add one, reference a secret, or paste a{" "}
					<code className="font-mono">.env</code> file. A service variable wins
					over the same name set higher up.
				</>
			}
			vars={own}
			secrets={{ available }}
			save={save.mutateAsync}
			savedHint="They apply from the next deployment."
			redeploy={async () => {
				const d = await deploy.mutateAsync(undefined);
				await navigate({
					to: "/projects/$projectId/services/$serviceId/deployments",
					params: { projectId, serviceId },
					search: { d: d.id },
				});
			}}
		>
			{(draft) => (
				<>
					<InheritedPanel
						vars={vars}
						draft={draft}
						projectId={projectId}
						environmentId={environmentId}
					/>
					<ContextPanel />
				</>
			)}
		</VariablesEditor>
	);
}
