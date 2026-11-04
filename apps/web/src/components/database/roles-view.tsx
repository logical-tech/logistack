import type { DatabaseSchema, DbRole } from "@logistack/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
	Code2,
	KeyRound,
	Loader2,
	Plus,
	RefreshCw,
	Search,
	Trash2,
	TriangleAlert,
	UserRound,
	UsersRound,
	X,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api";
import { databaseApi } from "@/lib/api/database";
import { cn } from "@/lib/utils";
import { type Dialect, dialectOf } from "./ddl";
import {
	ACCESS_LABEL,
	ACCESS_LEVELS,
	type Access,
	type AccessLevel,
	accessIn,
	accessSql,
	attributesSql,
	dropRoleSql,
	generatePassword,
	membershipSql,
	type RoleAttributes,
	roleKey,
	script,
} from "./roles";

const isForbidden = (e: unknown) => e instanceof ApiError && e.status === 403;
const errorText = (e: unknown) =>
	e instanceof Error ? e.message : "Something went wrong.";

/** Runs statements as one write run; a failed statement throws with the engine's message. */
export async function runStatements(
	serviceId: string,
	database: string | undefined,
	statements: string[],
) {
	const r = await databaseApi.query(serviceId, {
		sql: script(statements),
		readOnly: false,
		...(database && { database }),
	});
	if (r.error) throw new Error(r.error.message);
}

/** Schemas a role can be given access to; MySQL's global `*` is shown, never edited. */
const grantable = (s: DatabaseSchema) => s.schemas.map((x) => x.name);

/** The Roles view: every role of the instance beside the chosen one's attributes and access. */
export function RolesView({
	serviceId,
	schema,
	database,
	selected,
	onSelect,
	onCreate,
	forbidden,
	onForbidden,
}: {
	serviceId: string;
	schema: DatabaseSchema;
	database: string | undefined;
	selected: string | undefined;
	onSelect: (key: string | undefined) => void;
	onCreate: () => void;
	forbidden: boolean;
	onForbidden: () => void;
}) {
	const [query, setQuery] = useState("");
	const roles = schema.roles ?? [];
	const q = query.trim().toLowerCase();
	const listed = q
		? roles.filter((r) => roleKey(r).toLowerCase().includes(q))
		: roles;
	const current =
		roles.find((r) => roleKey(r) === selected) ??
		roles.find((r) => r.name !== schema.user) ??
		roles[0];

	if (!schema.roles)
		return (
			<div className="grid flex-1 place-items-center p-6">
				<EmptyState
					icon={UsersRound}
					title="Roles aren't readable"
					description="The explorer's login can't read the account list. It needs SELECT on mysql.user."
					className="w-full max-w-xl bg-transparent dark:bg-transparent"
				/>
			</div>
		);
	return (
		<>
			<aside
				aria-label="Roles"
				className="hidden w-64 shrink-0 flex-col border-r bg-sidebar/40 md:flex"
			>
				<div className="flex h-11 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
					<h2 className="flex-1 text-sm font-medium">
						{dialectOf(schema) === "postgres" ? "Roles" : "Accounts"}
						<span className="ml-1.5 font-normal text-muted-foreground tabular">
							{roles.length}
						</span>
					</h2>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="New role"
						title="New role"
						disabled={forbidden}
						onClick={onCreate}
					>
						<Plus />
					</Button>
				</div>
				<div className="relative border-b px-2 py-2">
					<Search
						className="pointer-events-none absolute top-1/2 left-4.5 size-3.5 -translate-y-1/2 text-muted-foreground"
						aria-hidden
					/>
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Filter roles"
						aria-label="Filter roles"
						className="h-8 pl-8 text-sm"
					/>
				</div>
				<ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
					{listed.map((r) => {
						const key = roleKey(r);
						const active = current && key === roleKey(current);
						return (
							<li key={key}>
								<button
									type="button"
									onClick={() => onSelect(key)}
									aria-current={active ? "true" : undefined}
									className={cn(
										"flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors duration-(--duration-quick) focus-visible:ring-2 focus-visible:ring-ring",
										active
											? "bg-muted font-medium"
											: "text-foreground/85 hover:bg-muted/60",
									)}
								>
									{r.login ? (
										<UserRound
											className="size-3.5 shrink-0 text-muted-foreground"
											strokeWidth={1.75}
											aria-label="Login role"
										/>
									) : (
										<UsersRound
											className="size-3.5 shrink-0 text-muted-foreground"
											strokeWidth={1.75}
											aria-label="Group role"
										/>
									)}
									<span className="min-w-0 flex-1 truncate">
										{r.name}
										{r.host !== undefined && (
											<span className="font-normal text-muted-foreground">
												@{r.host}
											</span>
										)}
									</span>
									{r.name === schema.user ? (
										<span className="shrink-0 text-xs font-normal text-muted-foreground">
											explorer
										</span>
									) : (
										r.superuser && (
											<span className="shrink-0 text-xs font-normal text-warn-text">
												superuser
											</span>
										)
									)}
								</button>
							</li>
						);
					})}
					{listed.length === 0 && (
						<li className="px-3 py-8 text-center text-sm text-muted-foreground">
							No role matches “{query}”.
						</li>
					)}
				</ul>
			</aside>
			<section
				aria-label={current ? `Role ${roleKey(current)}` : "Roles"}
				className="flex min-w-0 flex-1 flex-col"
			>
				<div className="border-b px-3 py-2 md:hidden">
					<Select
						value={current ? roleKey(current) : undefined}
						onValueChange={onSelect}
					>
						<SelectTrigger className="w-full" aria-label="Role">
							<SelectValue placeholder="Choose a role" />
						</SelectTrigger>
						<SelectContent>
							{roles.map((r) => (
								<SelectItem key={roleKey(r)} value={roleKey(r)}>
									{roleKey(r)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				{current ? (
					<RoleDetail
						key={`${database ?? ""}:${JSON.stringify(current)}`}
						serviceId={serviceId}
						schema={schema}
						database={database}
						role={current}
						forbidden={forbidden}
						onForbidden={onForbidden}
						onDropped={() => onSelect(undefined)}
						onCreate={onCreate}
					/>
				) : (
					<div className="grid flex-1 place-items-center p-6">
						<EmptyState
							icon={UsersRound}
							title="No roles yet"
							description="Give each app its own login, with only the access it needs."
							className="w-full max-w-xl bg-transparent dark:bg-transparent"
						>
							<Button disabled={forbidden} onClick={onCreate}>
								<Plus data-icon="inline-start" />
								New role
							</Button>
						</EmptyState>
					</div>
				)}
			</section>
		</>
	);
}

const ATTRIBUTES: {
	key: keyof RoleAttributes;
	label: string;
	hint: string;
}[] = [
	{
		key: "login",
		label: "Can log in",
		hint: "Off makes it a group role that others inherit privileges from.",
	},
	{ key: "createDb", label: "Create databases", hint: "CREATE DATABASE." },
	{
		key: "createRole",
		label: "Create roles",
		hint: "Create, alter and drop other non-superuser roles.",
	},
	{
		key: "superuser",
		label: "Superuser",
		hint: "Bypasses every permission check, grants included.",
	},
];

function RoleDetail({
	serviceId,
	schema,
	database,
	role,
	forbidden,
	onForbidden,
	onDropped,
	onCreate,
}: {
	serviceId: string;
	schema: DatabaseSchema;
	database: string | undefined;
	role: DbRole;
	forbidden: boolean;
	onForbidden: () => void;
	onDropped: () => void;
	onCreate: () => void;
}) {
	const uid = useId();
	const qc = useQueryClient();
	const dialect = dialectOf(schema);
	const pg = dialect === "postgres";
	const self = role.name === schema.user;
	const locked = self || forbidden;
	const schemas = grantable(schema);
	const initial = useMemo(
		() =>
			Object.fromEntries(
				schemas.map((s) => [s, accessIn(dialect, role, s)]),
			) as Record<string, Access>,
		[schemas, dialect, role],
	);
	const [attrs, setAttrs] = useState<RoleAttributes>({
		login: role.login,
		superuser: role.superuser,
		createDb: role.createDb ?? false,
		createRole: role.createRole ?? false,
	});
	const [groups, setGroups] = useState<string[]>(role.memberOf ?? []);
	const [access, setAccess] = useState<Record<string, Access>>(initial);
	const [showSql, setShowSql] = useState(false);
	const [saving, setSaving] = useState(false);
	const [password, setPassword] = useState(false);
	const [drop, setDrop] = useState(false);

	const statements = [
		...(pg ? attributesSql(role, role, attrs) : []),
		...(pg ? membershipSql(role, role.memberOf ?? [], groups) : []),
		...schemas.flatMap((s) => {
			const to = access[s];
			const from = initial[s] ?? "none";
			return to && to !== from && to !== "custom"
				? accessSql(dialect, role, s, from, to)
				: [];
		}),
	];
	const changes =
		(pg
			? ATTRIBUTES.filter((a) => Boolean(attrs[a.key]) !== Boolean(role[a.key]))
					.length +
				groups.filter((g) => !role.memberOf?.includes(g)).length +
				(role.memberOf ?? []).filter((g) => !groups.includes(g)).length
			: 0) + schemas.filter((s) => access[s] !== initial[s]).length;
	const candidates = (schema.roles ?? [])
		.filter((r) => r.name !== role.name && !groups.includes(r.name))
		.map((r) => r.name);
	const global = role.grants.find((g) => g.schema === "*");

	const apply = async () => {
		setSaving(true);
		try {
			await runStatements(serviceId, database, statements);
			toast.success(`Saved ${roleKey(role)}`);
			setShowSql(false);
			await qc.invalidateQueries({ queryKey: ["database", serviceId] });
		} catch (e) {
			if (isForbidden(e)) onForbidden();
			toast.error(`Couldn't save ${roleKey(role)}`, {
				description: isForbidden(e)
					? "Changing roles needs write on this service."
					: `${errorText(e)} Nothing was changed.`,
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto grid max-w-3xl gap-8 px-4 py-5 sm:px-6">
					<header className="flex flex-wrap items-start gap-3">
						<div className="min-w-0 flex-1">
							<h2 className="truncate text-lg font-semibold tracking-tight">
								{role.name}
								{role.host !== undefined && (
									<span className="font-normal text-muted-foreground">
										@{role.host}
									</span>
								)}
							</h2>
							<p className="mt-0.5 text-sm text-muted-foreground">
								{self
									? "The explorer signs in as this role. Its password lives in the service's environment."
									: role.superuser
										? "Superuser: every check below is bypassed."
										: pg
											? role.login
												? "A login role."
												: "A group role: members inherit its privileges."
											: "An account that signs in from this host."}
							</p>
						</div>
						{!self && (
							<div className="flex items-center gap-1.5">
								{role.login && (
									<Button
										variant="outline"
										size="sm"
										disabled={forbidden}
										onClick={() => setPassword(true)}
									>
										<KeyRound data-icon="inline-start" />
										Set password
									</Button>
								)}
								<Button
									variant="ghost"
									size="sm"
									className="text-bad-text hover:text-bad-text"
									disabled={forbidden}
									onClick={() => setDrop(true)}
								>
									<Trash2 data-icon="inline-start" />
									Drop
								</Button>
							</div>
						)}
					</header>

					{pg && (
						<section aria-labelledby={`${uid}-attrs`} className="grid gap-3">
							<h3 id={`${uid}-attrs`} className="text-sm font-medium">
								Attributes
							</h3>
							<ul className="divide-y rounded-lg ring-1 ring-border">
								{ATTRIBUTES.map((a) => (
									<li key={a.key} className="flex items-center gap-4 px-4 py-3">
										<label
											htmlFor={`${uid}-${a.key}`}
											className="min-w-0 flex-1 text-sm"
										>
											<span className="font-medium">{a.label}</span>
											<span className="mt-0.5 block text-muted-foreground">
												{a.hint}
											</span>
										</label>
										<Switch
											id={`${uid}-${a.key}`}
											checked={Boolean(attrs[a.key])}
											disabled={locked}
											onCheckedChange={(on) =>
												setAttrs((x) => ({ ...x, [a.key]: on }))
											}
										/>
									</li>
								))}
							</ul>
						</section>
					)}

					{pg && (
						<section aria-labelledby={`${uid}-groups`} className="grid gap-3">
							<div>
								<h3 id={`${uid}-groups`} className="text-sm font-medium">
									Member of
								</h3>
								<p className="mt-0.5 text-sm text-muted-foreground">
									It inherits every privilege of these roles.
								</p>
							</div>
							<div className="flex flex-wrap items-center gap-1.5">
								{groups.map((g) => (
									<span
										key={g}
										className="inline-flex h-7 items-center gap-1 rounded-md bg-muted pr-1 pl-2.5 text-sm"
									>
										{g}
										<Button
											variant="ghost"
											size="icon-xs"
											aria-label={`Remove from ${g}`}
											disabled={locked}
											onClick={() => setGroups((x) => x.filter((y) => y !== g))}
										>
											<X />
										</Button>
									</span>
								))}
								{candidates.length > 0 && !locked && (
									<Select
										value=""
										onValueChange={(g) => setGroups((x) => [...x, g].sort())}
									>
										<SelectTrigger
											size="sm"
											className="w-40"
											aria-label="Add to role"
										>
											<SelectValue placeholder="Add to role…" />
										</SelectTrigger>
										<SelectContent>
											{candidates.map((c) => (
												<SelectItem key={c} value={c}>
													{c}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
								{groups.length === 0 && (locked || candidates.length === 0) && (
									<span className="text-sm text-muted-foreground">None</span>
								)}
							</div>
						</section>
					)}

					<section aria-labelledby={`${uid}-access`} className="grid gap-3">
						<div>
							<h3 id={`${uid}-access`} className="text-sm font-medium">
								{pg ? `Access in ${schema.database}` : "Access"}
							</h3>
							<p className="mt-0.5 text-sm text-muted-foreground">
								{pg
									? "Privileges on every table and sequence of each schema, and on the ones the explorer creates later."
									: "Privileges on every table of each schema."}
							</p>
						</div>
						<ul className="divide-y rounded-lg ring-1 ring-border">
							{schemas.map((s) => {
								const value = access[s] ?? "none";
								const custom = initial[s] === "custom";
								const privileges =
									role.grants.find((g) => g.schema === s)?.privileges ?? [];
								return (
									<li key={s} className="flex items-center gap-4 px-4 py-2.5">
										<div className="min-w-0 flex-1">
											<p className="truncate font-mono text-sm">{s}</p>
											{custom && value === "custom" && (
												<p
													className="mt-0.5 truncate text-xs text-muted-foreground"
													title={privileges.join(", ")}
												>
													{privileges.join(", ").toLowerCase()}
												</p>
											)}
										</div>
										<Select
											value={value}
											disabled={locked}
											onValueChange={(v) =>
												setAccess((x) => ({ ...x, [s]: v as AccessLevel }))
											}
										>
											<SelectTrigger
												size="sm"
												className={cn(
													"w-36",
													value !== initial[s] && "ring-1 ring-brand",
												)}
												aria-label={`Access to ${s}`}
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{custom && (
													<SelectItem value="custom" disabled>
														{ACCESS_LABEL.custom}
													</SelectItem>
												)}
												{ACCESS_LEVELS.map((l) => (
													<SelectItem key={l} value={l}>
														{ACCESS_LABEL[l]}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</li>
								);
							})}
						</ul>
						{global && (
							<p className="text-sm text-muted-foreground">
								Global privileges on every schema:{" "}
								<span className="text-foreground">
									{global.privileges.length > 8
										? `${global.privileges.length} privileges`
										: global.privileges.join(", ").toLowerCase()}
								</span>
								.
							</p>
						)}
					</section>

					{!self && !forbidden && (
						<p className="text-sm text-muted-foreground">
							Need another login for an app?{" "}
							<Button
								variant="link"
								className="h-auto p-0 align-baseline"
								onClick={onCreate}
							>
								Create a role
							</Button>{" "}
							with only the access it needs.
						</p>
					)}
				</div>
			</div>

			{statements.length > 0 && (
				<div className="shrink-0 border-t bg-card">
					{showSql && (
						<pre className="max-h-48 overflow-auto border-b bg-muted/40 px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
							{script(statements)}
						</pre>
					)}
					<div className="flex items-center gap-2 px-3 py-2">
						<p className="flex-1 text-sm text-muted-foreground tabular">
							{changes} {changes === 1 ? "change" : "changes"} ·{" "}
							{statements.length}{" "}
							{statements.length === 1 ? "statement" : "statements"}
						</p>
						<Button
							variant="ghost"
							size="sm"
							aria-pressed={showSql}
							onClick={() => setShowSql((x) => !x)}
						>
							<Code2 data-icon="inline-start" />
							{showSql ? "Hide SQL" : "Review SQL"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={saving}
							onClick={() => {
								setAttrs({
									login: role.login,
									superuser: role.superuser,
									createDb: role.createDb ?? false,
									createRole: role.createRole ?? false,
								});
								setGroups(role.memberOf ?? []);
								setAccess(initial);
							}}
						>
							Discard
						</Button>
						<Button size="sm" disabled={saving} onClick={apply}>
							{saving && (
								<Loader2 className="animate-spin" data-icon="inline-start" />
							)}
							Apply
						</Button>
					</div>
				</div>
			)}

			<PasswordDialog
				open={password}
				onOpenChange={setPassword}
				serviceId={serviceId}
				role={role}
				onForbidden={onForbidden}
			/>
			<DropRoleDialog
				open={drop}
				onOpenChange={setDrop}
				serviceId={serviceId}
				database={database}
				dialect={dialect}
				role={role}
				user={schema.user}
				onDropped={onDropped}
				onForbidden={onForbidden}
			/>
		</>
	);
}

/** A new password, generated by default; LogiStack never keeps it. */
export function PasswordField({
	id,
	value,
	onChange,
	error,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	error?: string;
}) {
	return (
		<Field
			id={id}
			label="Password"
			error={error}
			hint="Generated here; LogiStack doesn't store it, so copy it now."
		>
			<div className="flex items-center gap-1.5">
				<Input
					id={id}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					autoComplete="new-password"
					autoCapitalize="none"
					spellCheck={false}
					className="font-mono"
					aria-invalid={error ? true : undefined}
				/>
				<Button
					type="button"
					variant="outline"
					size="icon"
					aria-label="Generate another password"
					title="Generate another"
					onClick={() => onChange(generatePassword())}
				>
					<RefreshCw />
				</Button>
				<CopyButton value={value} label="Copy password" />
			</div>
		</Field>
	);
}

function PasswordDialog({
	open,
	onOpenChange,
	serviceId,
	role,
	onForbidden,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	serviceId: string;
	role: DbRole;
	onForbidden: () => void;
}) {
	const uid = useId();
	const [value, setValue] = useState(generatePassword);
	const [pending, setPending] = useState(false);
	const short = value.length < 8;
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (pending) return;
				onOpenChange(o);
				if (!o) setValue(generatePassword());
			}}
		>
			<DialogContent className="sm:max-w-md">
				<form
					className="grid gap-5"
					onSubmit={async (e) => {
						e.preventDefault();
						if (short) return;
						setPending(true);
						try {
							await databaseApi.setRolePassword(
								serviceId,
								role.name,
								role.host,
								value,
							);
							toast.success(`New password set for ${roleKey(role)}`, {
								description:
									"Sessions already open keep working until they reconnect.",
							});
							onOpenChange(false);
							setValue(generatePassword());
						} catch (err) {
							if (isForbidden(err)) onForbidden();
							toast.error("Couldn't set the password", {
								description: isForbidden(err)
									? "Setting passwords needs admin on this service."
									: errorText(err),
							});
						} finally {
							setPending(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Set password for {roleKey(role)}</DialogTitle>
						<DialogDescription>
							It replaces the current one. Apps that sign in as {role.name} need
							the new one before they reconnect.
						</DialogDescription>
					</DialogHeader>
					<PasswordField
						id={`${uid}-password`}
						value={value}
						onChange={setValue}
						error={short && value ? "Use at least 8 characters" : undefined}
					/>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							disabled={pending}
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || short}>
							{pending && (
								<Loader2 className="animate-spin" data-icon="inline-start" />
							)}
							Set password
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function DropRoleDialog({
	open,
	onOpenChange,
	serviceId,
	database,
	dialect,
	role,
	user,
	onDropped,
	onForbidden,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	serviceId: string;
	database: string | undefined;
	dialect: Dialect;
	role: DbRole;
	user: string | undefined;
	onDropped: () => void;
	onForbidden: () => void;
}) {
	const uid = useId();
	const qc = useQueryClient();
	const key = roleKey(role);
	const [typed, setTyped] = useState("");
	const [pending, setPending] = useState(false);
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={(o) => {
				if (pending) return;
				onOpenChange(o);
				if (!o) setTyped("");
			}}
			title={`Drop ${key}?`}
			description={
				dialect === "postgres"
					? `Apps signing in as ${role.name} stop working. Tables it owns in this database pass to ${user ?? "the explorer's login"} first, so no data is lost; objects it owns in other databases block the drop.`
					: `Apps signing in as ${key} stop working, and its grants are deleted. This can't be undone.`
			}
			confirmLabel="Drop role"
			pending={pending}
			confirmDisabled={typed !== role.name}
			onConfirm={async () => {
				if (typed !== role.name) return;
				setPending(true);
				try {
					await runStatements(serviceId, database, dropRoleSql(dialect, role));
					toast.success(`Dropped ${key}`);
					onOpenChange(false);
					setTyped("");
					onDropped();
					qc.invalidateQueries({ queryKey: ["database", serviceId] });
				} catch (e) {
					if (isForbidden(e)) onForbidden();
					toast.error(`Couldn't drop ${key}`, {
						description: isForbidden(e)
							? "Dropping roles needs write on this service."
							: errorText(e),
					});
				} finally {
					setPending(false);
				}
			}}
		>
			<div className="grid gap-3">
				<p className="flex items-start gap-2 text-sm text-muted-foreground">
					<TriangleAlert
						className="mt-0.5 size-4 shrink-0 text-warn-text"
						aria-hidden
					/>
					Check that no running service still uses this login.
				</p>
				<Field id={`${uid}-confirm`} label={`Type ${role.name} to confirm`}>
					<Input
						id={`${uid}-confirm`}
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						placeholder={role.name}
						autoCapitalize="none"
						spellCheck={false}
						autoComplete="off"
						className="font-mono"
					/>
				</Field>
			</div>
		</ConfirmDialog>
	);
}
