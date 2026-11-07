import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	Eye,
	EyeOff,
	History,
	KeyRound,
	Link2,
	Loader2,
	Lock,
	MoreHorizontal,
	Pencil,
	Plus,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { type FocusEvent, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { Field } from "@/components/field";
import { Panel, SkeletonRows } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useMembers } from "@/lib/api/access";
import {
	SCOPE_LABEL,
	type SecretMeta,
	type SecretScope,
	secretsQuery,
	secretUsagesQuery,
	secretVersionsQuery,
	useSecretMutation,
} from "@/lib/api/secrets";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOTS = "••••••••••••";
/** How long a revealed value stays on screen. */
const REVEAL_MS = 20_000;

const errorText = (e: unknown) => (e instanceof Error ? e.message : undefined);

/** A member's name for a user id; ids of people who left read as "A former member". */
function useAuthor() {
	const { data: members } = useMembers();
	return (id: string | null) =>
		id
			? (members?.find((m) => m.userId === id)?.name ?? "A former member")
			: "LogiStack";
}

export function ScopeChip({
	scope,
	name,
	className,
}: {
	scope: SecretScope;
	name?: string;
	className?: string;
}) {
	return (
		<Badge
			variant="secondary"
			className={cn("max-w-full font-normal", className)}
			title={name ? `${SCOPE_LABEL[scope]}: ${name}` : SCOPE_LABEL[scope]}
		>
			<span className="truncate">
				{SCOPE_LABEL[scope]}
				{name ? <span className="text-muted-foreground"> · {name}</span> : null}
			</span>
		</Badge>
	);
}

/** Masked value with an eye button. Revealing is audited; the value hides on blur or after 20 s. */
function ValueCell({ secret }: { secret: SecretMeta }) {
	const [value, setValue] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	useEffect(() => {
		if (value === null) return;
		const t = setTimeout(() => setValue(null), REVEAL_MS);
		return () => clearTimeout(t);
	}, [value]);

	async function reveal() {
		setPending(true);
		try {
			const r = await api.secrets.reveal(secret.id);
			setValue(r.value);
			toast("Reveal recorded", {
				description: `Viewing ${secret.key} is in the audit log.`,
			});
		} catch (e) {
			toast.error("Couldn't reveal", { description: errorText(e) });
		} finally {
			setPending(false);
		}
	}
	const onBlur = (e: FocusEvent<HTMLDivElement>) => {
		if (!e.currentTarget.contains(e.relatedTarget)) setValue(null);
	};

	const shown = value !== null;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: focus leaving the cell's buttons hides the value
		<div className="flex min-w-0 items-center gap-0.5" onBlur={onBlur}>
			<span
				className={cn(
					"min-w-0 truncate font-mono text-[13px]",
					!shown && "text-muted-foreground tracking-wider",
				)}
				title={shown ? value : undefined}
			>
				{shown
					? value || <span className="text-muted-foreground">empty</span>
					: DOTS}
			</span>
			<Button
				variant="ghost"
				size="icon-xs"
				className="shrink-0 text-muted-foreground"
				aria-label={shown ? `Hide ${secret.key}` : `Reveal ${secret.key}`}
				aria-pressed={shown}
				disabled={pending}
				onClick={() => (shown ? setValue(null) : reveal())}
			>
				{pending ? (
					<Loader2 className="animate-spin" />
				) : shown ? (
					<EyeOff />
				) : (
					<Eye />
				)}
			</Button>
			{shown && (
				<CopyButton
					value={value}
					label={`Copy ${secret.key}`}
					className="size-6 shrink-0"
				/>
			)}
		</div>
	);
}

type Open =
	| { kind: "add" }
	| { kind: "edit" | "history" | "usages" | "delete"; secret: SecretMeta };

/**
 * The secrets defined at one scope: masked values with an audited reveal, versions and
 * rollback, the services that reference each, and create / edit / delete.
 */
export function SecretsPanel({
	scope,
	scopeId,
	title,
	empty,
	id,
}: {
	scope: SecretScope;
	scopeId: string;
	title: string;
	empty: string;
	id: string;
}) {
	const { data } = useQuery(secretsQuery(scope, scopeId));
	const [open, setOpen] = useState<Open | null>(null);
	const close = () => setOpen(null);
	const remove = useSecretMutation((s: SecretMeta) => api.secrets.remove(s.id));

	return (
		<>
			<Panel
				title={title}
				id={id}
				actions={
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setOpen({ kind: "add" })}
					>
						<Plus data-icon="inline-start" />
						Add secret
					</Button>
				}
			>
				{!data ? (
					<SkeletonRows rows={3} />
				) : data.length === 0 ? (
					<div className="flex items-start gap-3 px-4 py-6">
						<KeyRound
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							aria-hidden
						/>
						<p className="text-sm text-pretty text-muted-foreground">{empty}</p>
					</div>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full min-w-[48rem] table-fixed text-sm">
							<caption className="sr-only">{title}</caption>
							<colgroup>
								<col className="w-[30%]" />
								<col />
								<col className="w-32" />
								<col className="w-14" />
								<col className="w-20" />
								<col className="w-28" />
								<col className="w-11" />
							</colgroup>
							<thead className="border-b text-xs text-muted-foreground">
								<tr className="[&>th]:h-9 [&>th]:px-3 [&>th]:text-left [&>th]:font-medium [&>th:first-child]:pl-4">
									<th scope="col">Key</th>
									<th scope="col">Value</th>
									<th scope="col">Scope</th>
									<th scope="col" className="text-right!">
										Version
									</th>
									<th scope="col" className="text-right!">
										Used by
									</th>
									<th scope="col">Updated</th>
									<th scope="col">
										<span className="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody className="divide-y">
								{data.map((s) => (
									<tr
										key={s.id}
										className="transition-colors duration-(--duration-quick) hover:bg-muted/40 [&>td]:h-11 [&>td]:px-3 [&>td:first-child]:pl-4"
									>
										<td className="min-w-0">
											<div className="flex min-w-0 items-center gap-2">
												<Lock
													className="size-3.5 shrink-0 text-muted-foreground"
													aria-hidden
												/>
												<span
													className="truncate font-mono text-[13px]"
													title={s.key}
												>
													{s.key}
												</span>
											</div>
											{s.description && (
												<p
													className="truncate pl-5.5 text-xs text-muted-foreground"
													title={s.description}
												>
													{s.description}
												</p>
											)}
										</td>
										<td>
											<ValueCell secret={s} />
										</td>
										<td>
											<ScopeChip scope={s.scope} />
										</td>
										<td className="text-right tabular text-muted-foreground">
											v{s.version}
										</td>
										<td className="text-right tabular">
											{s.usedBy > 0 ? (
												<button
													type="button"
													className="rounded underline decoration-muted-foreground/40 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
													aria-label={`Used by ${s.usedBy}: show usages of ${s.key}`}
													onClick={() => setOpen({ kind: "usages", secret: s })}
												>
													{s.usedBy}
												</button>
											) : (
												<span className="text-muted-foreground">0</span>
											)}
										</td>
										<td
											className="truncate text-muted-foreground"
											title={new Date(s.updatedAt).toLocaleString()}
										>
											{relativeTime(s.updatedAt)}
										</td>
										<td className="text-right">
											<RowMenu secret={s} onOpen={setOpen} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Panel>

			<SecretDialog
				scope={scope}
				scopeId={scopeId}
				secret={
					open?.kind === "edit"
						? open.secret
						: open?.kind === "add"
							? null
							: undefined
				}
				onClose={close}
			/>
			<HistorySheet
				secret={open?.kind === "history" ? open.secret : null}
				onClose={close}
			/>
			<UsagesDialog
				secret={open?.kind === "usages" ? open.secret : null}
				onClose={close}
			/>
			<ConfirmDialog
				open={open?.kind === "delete"}
				onOpenChange={(o) => !o && close()}
				title={
					open?.kind === "delete"
						? `Delete ${open.secret.key}?`
						: "Delete secret?"
				}
				description="Its value and every earlier version are deleted. Nothing references it, so no service changes."
				confirmLabel="Delete secret"
				pending={remove.isPending}
				onConfirm={() =>
					open?.kind === "delete" &&
					remove.mutate(open.secret, {
						onSuccess: () => {
							toast.success(`${open.secret.key} deleted`);
							close();
						},
						onError: (e) =>
							toast.error("Couldn't delete", { description: errorText(e) }),
					})
				}
			/>
		</>
	);
}

function RowMenu({
	secret: s,
	onOpen,
}: {
	secret: SecretMeta;
	onOpen: (o: Open) => void;
}) {
	const used = s.usedBy > 0;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					className="text-muted-foreground"
					aria-label={`Actions for ${s.key}`}
				>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-52">
				<DropdownMenuItem onSelect={() => onOpen({ kind: "edit", secret: s })}>
					<Pencil />
					Edit value
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() => onOpen({ kind: "history", secret: s })}
				>
					<History />
					History
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() => onOpen({ kind: "usages", secret: s })}
				>
					<Link2 />
					Usages
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() =>
						navigator.clipboard.writeText(`${s.key}@${s.scope}`).then(
							() =>
								toast.success("Reference copied", {
									description: `${s.key}@${s.scope}`,
								}),
							() => toast.error("Couldn't copy"),
						)
					}
				>
					<KeyRound />
					Copy reference
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				{used ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<div>
								<DropdownMenuItem variant="destructive" disabled>
									<Trash2 />
									Delete
									<span className="ml-auto text-xs">In use</span>
								</DropdownMenuItem>
							</div>
						</TooltipTrigger>
						<TooltipContent side="left" className="max-w-56">
							{s.usedBy} service{" "}
							{s.usedBy === 1 ? "variable references" : "variables reference"}{" "}
							it. Point them elsewhere first.
						</TooltipContent>
					</Tooltip>
				) : (
					<DropdownMenuItem
						variant="destructive"
						onSelect={() => onOpen({ kind: "delete", secret: s })}
					>
						<Trash2 />
						Delete
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Add (secret: null) or edit (a secret); closed when undefined. */
function SecretDialog({
	scope,
	scopeId,
	secret,
	onClose,
}: {
	scope: SecretScope;
	scopeId: string;
	secret: SecretMeta | null | undefined;
	onClose: () => void;
}) {
	return (
		<Dialog open={secret !== undefined} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-md">
				{secret !== undefined && (
					<SecretForm
						key={secret?.id ?? "new"}
						scope={scope}
						scopeId={scopeId}
						secret={secret}
						onClose={onClose}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function SecretForm({
	scope,
	scopeId,
	secret,
	onClose,
}: {
	scope: SecretScope;
	scopeId: string;
	secret: SecretMeta | null;
	onClose: () => void;
}) {
	const uid = useId();
	const [key, setKey] = useState(secret?.key ?? "");
	const [value, setValue] = useState("");
	const [description, setDescription] = useState(secret?.description ?? "");
	const [touched, setTouched] = useState(false);
	const save = useSecretMutation(async () => {
		const desc = description.trim();
		if (secret)
			return api.secrets.update(secret.id, {
				...(value ? { value } : {}),
				description: desc || null,
			});
		return api.secrets.create({
			scope,
			scopeId,
			key,
			value,
			...(desc ? { description: desc } : {}),
		});
	});
	const keyError = secret
		? undefined
		: !key
			? "Name it"
			: !KEY.test(key)
				? "Letters, digits and _, not starting with a digit"
				: undefined;
	const valueError = !secret && !value ? "Enter a value" : undefined;
	const unchanged =
		!!secret && !value && description.trim() === (secret.description ?? "");

	return (
		<form
			className="grid gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				setTouched(true);
				if (keyError || valueError || unchanged) return;
				save.mutate(undefined, {
					onSuccess: (s) => {
						toast.success(secret ? `${s.key} saved` : `${s.key} added`, {
							description:
								secret && value
									? `Now version ${s.version}. Services that reference it get it on their next deployment.`
									: "Reference it from a service's Environment tab.",
						});
						onClose();
					},
					onError: (e) =>
						toast.error("Couldn't save", { description: errorText(e) }),
				});
			}}
		>
			<DialogHeader>
				<DialogTitle>
					{secret ? `Edit ${secret.key}` : "Add secret"}
				</DialogTitle>
				<DialogDescription>
					{secret
						? `A new value becomes version ${secret.version + 1}. Leave it empty to keep version ${secret.version}.`
						: "Stored encrypted. Services below this scope can reference it; none receive it until they do."}
				</DialogDescription>
			</DialogHeader>
			{!secret && (
				<Field
					id={`${uid}-key`}
					label="Key"
					error={touched ? keyError : undefined}
				>
					<Input
						id={`${uid}-key`}
						value={key}
						onChange={(e) => setKey(e.target.value.trim())}
						placeholder="STRIPE_SECRET_KEY"
						spellCheck={false}
						autoCapitalize="off"
						autoComplete="off"
						aria-invalid={touched && keyError ? true : undefined}
						className="font-mono text-[13px] md:text-[13px]"
						autoFocus
					/>
				</Field>
			)}
			<Field
				id={`${uid}-value`}
				label={secret ? "New value" : "Value"}
				error={touched ? valueError : undefined}
			>
				<Textarea
					id={`${uid}-value`}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					rows={3}
					spellCheck={false}
					autoComplete="off"
					placeholder={secret ? "Unchanged" : undefined}
					aria-invalid={touched && valueError ? true : undefined}
					className="font-mono text-[13px] [-webkit-text-security:disc] focus:[-webkit-text-security:none]"
					autoFocus={!!secret}
				/>
			</Field>
			<Field id={`${uid}-desc`} label="Description" optional>
				<Input
					id={`${uid}-desc`}
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					maxLength={500}
					placeholder="What it is for, who rotates it"
				/>
			</Field>
			<DialogFooter>
				<Button type="button" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" disabled={save.isPending || unchanged}>
					{save.isPending && <Loader2 className="animate-spin" />}
					{secret ? "Save" : "Add secret"}
				</Button>
			</DialogFooter>
		</form>
	);
}

function HistorySheet({
	secret,
	onClose,
}: {
	secret: SecretMeta | null;
	onClose: () => void;
}) {
	return (
		<Sheet open={secret !== null} onOpenChange={(o) => !o && onClose()}>
			<SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-md">
				{secret && <HistoryBody key={secret.id} secret={secret} />}
			</SheetContent>
		</Sheet>
	);
}

function HistoryBody({ secret }: { secret: SecretMeta }) {
	const { data } = useQuery(secretVersionsQuery(secret.id));
	const author = useAuthor();
	const rollback = useSecretMutation((version: number) =>
		api.secrets.rollback(secret.id, version),
	);
	return (
		<>
			<SheetHeader className="border-b p-5 pr-12">
				<SheetTitle className="text-base">History</SheetTitle>
				<SheetDescription className="font-mono text-xs">
					{secret.key}
				</SheetDescription>
			</SheetHeader>
			<p className="px-5 pt-4 text-sm text-pretty text-muted-foreground">
				Rolling back copies an earlier value as a new version, so this list only
				grows. Services get it on their next deployment.
			</p>
			{!data ? (
				<SkeletonRows rows={3} className="mt-2" />
			) : (
				<ol className="mt-3 divide-y border-y">
					{data.map((v) => (
						<li key={v.version} className="flex items-center gap-3 px-5 py-3">
							<span className="w-9 shrink-0 font-medium tabular">
								v{v.version}
							</span>
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm">{author(v.createdBy)}</p>
								<p
									className="text-xs text-muted-foreground"
									title={new Date(v.createdAt).toLocaleString()}
								>
									{relativeTime(v.createdAt)}
								</p>
							</div>
							{v.current ? (
								<Badge variant="secondary">Current</Badge>
							) : (
								<Button
									variant="ghost"
									size="sm"
									disabled={rollback.isPending}
									onClick={() =>
										rollback.mutate(v.version, {
											onSuccess: (s) =>
												toast.success(`Restored v${v.version}`, {
													description: `Its value is now version ${s.version}. Redeploy the services that use it to apply it.`,
												}),
											onError: (e) =>
												toast.error("Couldn't roll back", {
													description: errorText(e),
												}),
										})
									}
								>
									<RotateCcw data-icon="inline-start" />
									Roll back
								</Button>
							)}
						</li>
					))}
				</ol>
			)}
		</>
	);
}

function UsagesDialog({
	secret,
	onClose,
}: {
	secret: SecretMeta | null;
	onClose: () => void;
}) {
	const { data } = useQuery({
		...secretUsagesQuery(secret?.id ?? ""),
		enabled: secret !== null,
	});
	return (
		<Dialog open={secret !== null} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Usages</DialogTitle>
					<DialogDescription>
						Services whose environment references{" "}
						<code className="font-mono">{secret?.key}</code>. Only these receive
						it.
					</DialogDescription>
				</DialogHeader>
				{!data ? (
					<SkeletonRows rows={2} />
				) : data.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No service references it yet. Pick it from a service's Environment
						tab.
					</p>
				) : (
					<ul className="-mx-2 grid gap-0.5">
						{data.map((u) => (
							<li key={u.envVarId}>
								<Link
									to="/projects/$projectId/services/$serviceId/environment"
									params={{ projectId: u.projectId, serviceId: u.serviceId }}
									onClick={onClose}
									className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 outline-none transition-colors duration-(--duration-quick) hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span className="truncate text-sm font-medium">
										{u.serviceName}
									</span>
									<span className="truncate font-mono text-xs text-muted-foreground">
										as {u.key}
									</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Admins only: a new data key for the organization; references and values stay as they are. */
export function RotateKeyButton() {
	const [open, setOpen] = useState(false);
	const rotate = useSecretMutation(() => api.secrets.rotateKey());
	return (
		<>
			<Button variant="outline" onClick={() => setOpen(true)}>
				<RotateCcw data-icon="inline-start" />
				Rotate encryption key
			</Button>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				destructive={false}
				title="Rotate the encryption key?"
				description="LogiStack creates a new data key for the organization and re-encrypts every secret version with it. Values, versions and references do not change, and no service needs a redeploy. Safe to repeat."
				confirmLabel="Rotate key"
				pending={rotate.isPending}
				onConfirm={() =>
					rotate.mutate(undefined, {
						onSuccess: (r) => {
							toast.success("Encryption key rotated", {
								description: `${r.reencrypted} ${r.reencrypted === 1 ? "version" : "versions"} re-encrypted under key ${r.version}.`,
							});
							setOpen(false);
						},
						onError: (e) =>
							toast.error("Couldn't rotate", { description: errorText(e) }),
					})
				}
			/>
		</>
	);
}
