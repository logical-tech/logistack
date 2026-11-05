import {
	deploymentContextVars,
	isReservedEnvKey,
	RESERVED_ENV_PREFIX,
} from "@logistack/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
	ClipboardPaste,
	CopyPlus,
	Eye,
	EyeOff,
	Lock,
	Plus,
	Trash2,
} from "lucide-react";
import { type ClipboardEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import {
	type EffectiveEnvVar,
	type EnvScope,
	useServiceMutation,
} from "@/lib/api/service-ops";
import type { ProjectId, ServiceId } from "@/lib/api/types";
import { parseDotenv } from "@/lib/dotenv";
import { cn } from "@/lib/utils";

/** One editable service-scope variable. `value: null` keeps a stored value this user cannot see. */
type Row = {
	uid: string;
	key: string;
	value: string | null;
	isSecret: boolean;
	isBuildTime: boolean;
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
const SECRETISH = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|(^|_)KEY$|DSN$/i;
const DOTS = "••••••••••••";

let uidSeq = 0;
const uid = () => `r${uidSeq++}`;
const toRow = (v: EffectiveEnvVar): Row => ({
	uid: uid(),
	key: v.key,
	value: v.value,
	isSecret: v.isSecret,
	isBuildTime: v.isBuildTime,
});
/** Content without row ids or order, to compare a draft with the server's set. */
const signature = (rows: Row[]) =>
	JSON.stringify(
		rows
			.map(({ uid: _, ...r }) => r)
			.sort((a, b) => a.key.localeCompare(b.key)),
	);

/** A problem with one row, or null. */
function rowError(r: Row, rows: Row[], stored: Set<string>) {
	if (!r.key) return "Name it";
	if (!KEY.test(r.key))
		return "Letters, digits and _, not starting with a digit";
	if (isReservedEnvKey(r.key))
		return `${RESERVED_ENV_PREFIX} names are set by LogiStack`;
	if (rows.filter((o) => o.key === r.key).length > 1) return "Defined twice";
	if (r.value === null && !stored.has(r.key))
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

export function EnvEditor({
	serviceId,
	projectId,
	vars,
}: {
	serviceId: ServiceId;
	projectId: ProjectId;
	vars: EffectiveEnvVar[];
}) {
	const navigate = useNavigate();
	const initial = useMemo(
		() => vars.filter((v) => v.scope === "service").map(toRow),
		[vars],
	);
	const stored = useMemo(() => new Set(initial.map((r) => r.key)), [initial]);
	const [rows, setRows] = useState<Row[]>(initial);
	const [base, setBase] = useState(() => signature(initial));
	const [revealed, setRevealed] = useState<Set<string>>(new Set());
	const [pasteOpen, setPasteOpen] = useState(false);
	const [pasteText, setPasteText] = useState("");

	// The server's set changed: take it, unless that would drop edits made since the last sync.
	const incoming = signature(initial);
	const draft = signature(rows);
	if (incoming !== base) {
		if (draft === base || draft === incoming) setRows(initial);
		setBase(incoming);
	}

	const inherited = vars.filter((v) => v.scope !== "service");
	const drafted = new Set(rows.map((r) => r.key));
	const overridden = (v: EffectiveEnvVar) =>
		drafted.has(v.key) ||
		inherited.some((o) => o.key === v.key && RANK[o.scope] > RANK[v.scope]);
	const errors = rows.map((r) => rowError(r, rows, stored));
	const dirty = draft !== incoming;
	const valid = errors.every((e) => e === null);

	const save = useServiceMutation(serviceId, () =>
		api.serviceOps.saveEnvVars(
			serviceId,
			rows.map((r) => ({
				key: r.key,
				isSecret: r.isSecret,
				isBuildTime: r.isBuildTime,
				...(r.value === null ? {} : { value: r.value }),
			})),
		),
	);
	const deploy = useServiceMutation(serviceId, () =>
		api.serviceOps.deploy(serviceId),
	);
	const busy = save.isPending || deploy.isPending;

	const update = (id: string, patch: Partial<Row>) =>
		setRows((rs) => rs.map((r) => (r.uid === id ? { ...r, ...patch } : r)));
	const remove = (id: string) =>
		setRows((rs) => rs.filter((r) => r.uid !== id));
	const add = (key = "", value: string | null = "") =>
		setRows((rs) => [
			...rs,
			{
				uid: uid(),
				key,
				value,
				isSecret: SECRETISH.test(key),
				isBuildTime: false,
			},
		]);

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
				if (existing) existing.value = v.value;
				else
					next.push({
						uid: uid(),
						key: v.key,
						value: v.value,
						isSecret: SECRETISH.test(v.key),
						isBuildTime: false,
					});
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

	async function submit(redeploy: boolean) {
		try {
			await save.mutateAsync(undefined);
			if (!redeploy) {
				toast.success("Variables saved", {
					description: "They apply from the next deployment.",
				});
				return;
			}
			const d = await deploy.mutateAsync(undefined);
			navigate({
				to: "/projects/$projectId/services/$serviceId/deployments",
				params: { projectId, serviceId },
				search: { d: d.id },
			});
		} catch (e) {
			toast.error(redeploy ? "Couldn't save and redeploy" : "Couldn't save", {
				description: e instanceof Error ? e.message : undefined,
			});
		}
	}

	const reveal = (k: string) =>
		setRevealed((s) => {
			const next = new Set(s);
			if (next.has(k)) next.delete(k);
			else next.add(k);
			return next;
		});

	const preview = pasteText ? parseDotenv(pasteText) : null;

	return (
		<div className="grid gap-8">
			<Panel
				title="Service variables"
				id="service-vars"
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
					<p className="px-4 py-6 text-sm text-muted-foreground">
						None yet. Add one, or paste a{" "}
						<code className="font-mono">.env</code> file. A service variable
						wins over the same name set higher up.
					</p>
				) : (
					<ul className="divide-y">
						{rows.map((r, i) => {
							const error = errors[i];
							const shown = !r.isSecret || revealed.has(r.uid);
							return (
								<li
									key={r.uid}
									className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] md:items-start"
								>
									<div className="min-w-0">
										<input
											value={r.key}
											onChange={(e) =>
												update(r.uid, { key: e.target.value.trim() })
											}
											onPaste={(e) => onKeyPaste(e, r)}
											placeholder="NAME"
											aria-label={`Name of variable ${i + 1}`}
											aria-invalid={error ? true : undefined}
											spellCheck={false}
											autoCapitalize="off"
											// biome-ignore lint/a11y/noAutofocus: focus the row just added
											autoFocus={!r.key && i === rows.length - 1}
											className="h-8 w-full rounded-lg bg-muted/60 px-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring aria-invalid:ring-2 aria-invalid:ring-destructive/40 dark:bg-muted/40"
										/>
										{error && (
											<p className="mt-1 text-xs text-bad-text">{error}</p>
										)}
									</div>
									<div className="relative min-w-0">
										<input
											type={shown ? "text" : "password"}
											value={r.value ?? ""}
											onChange={(e) => update(r.uid, { value: e.target.value })}
											placeholder={
												r.value === null
													? "Hidden. Type to replace it"
													: "value"
											}
											aria-label={`Value of ${r.key || `variable ${i + 1}`}`}
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
									<div className="flex h-8 items-center gap-4">
										<Toggle
											label="Secret"
											checked={r.isSecret}
											onChange={(isSecret) => update(r.uid, { isSecret })}
										/>
										<Toggle
											label="Build"
											checked={r.isBuildTime}
											onChange={(isBuildTime) => update(r.uid, { isBuildTime })}
										/>
										<Button
											variant="ghost"
											size="icon-sm"
											className="ml-auto text-muted-foreground"
											aria-label={`Remove ${r.key || `variable ${i + 1}`}`}
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

			<Panel title="Inherited" id="inherited-vars">
				{inherited.length === 0 ? (
					<p className="px-4 py-6 text-sm text-muted-foreground">
						Nothing is set for the organization, project or environment.
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
														aria-label={
															shown ? `Hide ${v.key}` : `Show ${v.key}`
														}
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
											disabled={drafted.has(v.key)}
											onClick={() => add(v.key, v.value ?? "")}
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

			<Panel title="Set on every deployment" id="context-vars">
				<p className="border-b px-4 py-3 text-sm text-pretty text-muted-foreground">
					Read-only. Containers get these at runtime, and a Dockerfile build
					gets the ones it declares with <code className="font-mono">ARG</code>.
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
						variant="outline"
						disabled={!valid || busy}
						onClick={() => submit(false)}
					>
						Save
					</Button>
					<Button disabled={!valid || busy} onClick={() => submit(true)}>
						Save and redeploy
					</Button>
				</div>
			)}

			<Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Paste a .env file</DialogTitle>
						<DialogDescription>
							KEY=value lines; comments, quotes and{" "}
							<code className="font-mono">export</code> are understood. Names
							that already exist take the pasted value.
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
						<p className="text-sm text-muted-foreground">
							{preview.variables.length}{" "}
							{preview.variables.length === 1 ? "variable" : "variables"}
							{preview.invalid.length > 0 &&
								`, line ${preview.invalid.join(", ")} skipped`}
						</p>
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
