import {
	type ApplicationSpec,
	type BindMount,
	type Capability,
	isSensitiveHostPath,
	linuxCapabilities,
	type RestartCondition,
} from "@logistack/contracts";
import { Plus, ShieldAlert, Trash2, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
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
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** The spec fields that reach past the container: ports, host paths, identity, capabilities, restart. */
export type HostSettings = Pick<
	ApplicationSpec,
	"ports" | "mounts" | "user" | "capAdd" | "capDrop" | "restart"
>;
type Patch = (patch: Partial<HostSettings>) => void;
/** Zod issues from parsing the whole spec; each control shows the one at its own path. */
export type SpecIssues = readonly {
	path: readonly PropertyKey[];
	message: string;
}[];

const issueAt = (issues: SpecIssues, ...path: PropertyKey[]) =>
	issues.find(
		(i) =>
			i.path.length === path.length && path.every((p, j) => i.path[j] === p),
	)?.message;

/** The TCP port a domain routes to, unless a published row already maps that container port over TCP. */
export const withRoutedPort = (
	target: number,
	ports: HostSettings["ports"],
): HostSettings["ports"] =>
	ports.some((p) => p.target === target && p.protocol === "tcp")
		? ports
		: [{ target, protocol: "tcp" }, ...ports];

const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
/** Empty lists are left out of the spec, so an untouched service stays byte-identical. */
const listOrUndefined = <T,>(xs: T[]) => (xs.length ? xs : undefined);

const PORT_ROW =
	"sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6.25rem_9.5rem_2.25rem]";
const MOUNT_ROW = "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6.25rem_2.25rem]";

export function PortRows({
	value,
	onChange,
	issues,
}: {
	value: HostSettings;
	onChange: Patch;
	issues: SpecIssues;
}) {
	const { ports } = value;
	const set = (i: number, patch: Partial<HostSettings["ports"][number]>) =>
		onChange({
			ports: ports.map((p, j) => (j === i ? { ...p, ...patch } : p)),
		});
	return (
		<div className="grid gap-2">
			{ports.length > 0 && (
				<div
					aria-hidden
					className={cn("hidden gap-2 text-sm font-medium sm:grid", PORT_ROW)}
				>
					<span>Container port</span>
					<span>Published</span>
					<span>Protocol</span>
					<span>Bind on</span>
				</div>
			)}
			{ports.map((p, i) => {
				// A fresh row starts at 0; it is flagged once something is typed, and Save stays blocked.
				const error =
					(p.target !== 0 && issueAt(issues, "ports", i, "target")) ||
					(p.published !== undefined &&
						issueAt(issues, "ports", i, "published"))
						? "Ports go from 1 to 65535."
						: undefined;
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
						key={i}
						className="grid gap-1.5"
					>
						<div
							className={cn(
								"grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem] items-center gap-2",
								PORT_ROW,
							)}
						>
							<Input
								type="number"
								inputMode="numeric"
								aria-label={`Container port ${i + 1}`}
								aria-invalid={error ? true : undefined}
								placeholder="3000"
								className="tabular"
								value={p.target || ""}
								onChange={(e) => set(i, { target: num(e.target.value) ?? 0 })}
							/>
							<Input
								type="number"
								inputMode="numeric"
								aria-label={`Published port ${i + 1}`}
								placeholder="Not published"
								className="tabular"
								value={p.published ?? ""}
								onChange={(e) => set(i, { published: num(e.target.value) })}
							/>
							<Segmented
								label={`Protocol ${i + 1}`}
								value={p.protocol}
								onChange={(protocol) => set(i, { protocol })}
								options={[
									{ value: "tcp", label: "TCP" },
									{ value: "udp", label: "UDP" },
								]}
							/>
							<Select
								value={p.mode ?? "host"}
								disabled={!p.published}
								onValueChange={(m) =>
									set(i, { mode: m === "ingress" ? "ingress" : undefined })
								}
							>
								<SelectTrigger
									aria-label={`Bind port ${i + 1} on`}
									className="w-full"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="host">Its node</SelectItem>
									<SelectItem value="ingress">Every node</SelectItem>
								</SelectContent>
							</Select>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={`Remove port ${i + 1}`}
								className="col-start-3 row-start-1 justify-self-end text-muted-foreground sm:col-start-auto sm:row-start-auto"
								onClick={() =>
									onChange({ ports: ports.filter((_, j) => j !== i) })
								}
							>
								<Trash2 />
							</Button>
						</div>
						{error && (
							<p className="text-xs text-bad-text" aria-live="polite">
								{error}
							</p>
						)}
					</div>
				);
			})}
			<div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() =>
						onChange({ ports: [...ports, { target: 0, protocol: "tcp" }] })
					}
				>
					<Plus data-icon="inline-start" />
					Add port
				</Button>
			</div>
		</div>
	);
}

function MountRow({
	mount: m,
	index: i,
	issues,
	onChange,
	onRemove,
}: {
	mount: BindMount;
	index: number;
	issues: SpecIssues;
	onChange: (m: BindMount) => void;
	onRemove: () => void;
}) {
	// "" prefixes every denied path, so an empty field would read as sensitive.
	const sensitive = m.hostPath !== "" && isSensitiveHostPath(m.hostPath);
	// The sensitive-path refinement has its own confirmation below, so its issue is not repeated.
	const hostError = sensitive
		? undefined
		: m.hostPath && issueAt(issues, "mounts", i, "hostPath");
	const targetError = m.target && issueAt(issues, "mounts", i, "target");
	const confirmId = `mount-${i}-sensitive`;
	return (
		<div className="grid gap-1.5">
			<div
				className={cn(
					"grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-2",
					MOUNT_ROW,
				)}
			>
				<Input
					aria-label={`Host path ${i + 1}`}
					aria-invalid={
						hostError || (sensitive && !m.allowSensitiveHostPath)
							? true
							: undefined
					}
					placeholder="/srv/factorio"
					spellCheck={false}
					autoCapitalize="none"
					className="font-mono"
					value={m.hostPath}
					onChange={(e) => {
						// A confirmation covers the exact path it was given for.
						const { allowSensitiveHostPath: _, ...rest } = m;
						onChange({ ...rest, hostPath: e.target.value });
					}}
				/>
				<Input
					aria-label={`Container path ${i + 1}`}
					aria-invalid={targetError ? true : undefined}
					placeholder="/factorio"
					spellCheck={false}
					autoCapitalize="none"
					className="col-start-1 font-mono sm:col-start-auto"
					value={m.target}
					onChange={(e) => onChange({ ...m, target: e.target.value })}
				/>
				<label
					htmlFor={`mount-${i}-ro`}
					className="col-start-1 flex h-9 items-center gap-2 text-sm whitespace-nowrap sm:col-start-auto"
				>
					<Checkbox
						id={`mount-${i}-ro`}
						checked={m.readOnly ?? false}
						onCheckedChange={(c) =>
							onChange({ ...m, readOnly: c === true ? true : undefined })
						}
					/>
					Read-only
				</label>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={`Remove bind mount ${i + 1}`}
					className="col-start-2 row-start-1 justify-self-end text-muted-foreground sm:col-start-auto sm:row-start-auto"
					onClick={onRemove}
				>
					<Trash2 />
				</Button>
			</div>
			{(hostError || targetError) && (
				<p className="text-xs text-bad-text" aria-live="polite">
					{hostError
						? `Host path ${hostError}`
						: `Container path ${targetError}`}
				</p>
			)}
			{sensitive && (
				<div className="t-reveal grid gap-2 rounded-lg bg-bad/8 px-3.5 py-3 text-sm dark:bg-bad/12">
					<p className="flex items-start gap-2.5">
						<ShieldAlert
							className="mt-0.5 size-4 shrink-0 text-bad-text"
							aria-hidden
						/>
						<span>
							<span className="font-mono text-[13px]">{m.hostPath}</span>{" "}
							<span className="text-muted-foreground">
								reaches the host's system files or the Docker socket. A
								container with it can take over the node.
							</span>
						</span>
					</p>
					<label
						htmlFor={confirmId}
						className="flex items-center gap-2.5 pl-6.5 font-medium"
					>
						<Checkbox
							id={confirmId}
							checked={m.allowSensitiveHostPath ?? false}
							onCheckedChange={(c) => {
								const { allowSensitiveHostPath: _, ...rest } = m;
								onChange(
									c === true ? { ...rest, allowSensitiveHostPath: true } : rest,
								);
							}}
						/>
						I understand, mount it anyway
					</label>
				</div>
			)}
		</div>
	);
}

export function MountRows({
	value,
	onChange,
	issues,
}: {
	value: HostSettings;
	onChange: Patch;
	issues: SpecIssues;
}) {
	const mounts = value.mounts ?? [];
	const setMounts = (next: BindMount[]) =>
		onChange({ mounts: listOrUndefined(next) });
	return (
		<div className="grid gap-2">
			{mounts.length > 0 && (
				<>
					<div className="t-reveal mb-1 flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
						<TriangleAlert
							className="mt-0.5 size-4 shrink-0 text-warn-text"
							aria-hidden
						/>
						<p className="max-w-[68ch] text-pretty">
							<span className="font-medium">
								Host paths bypass LogiStack's volumes.
							</span>{" "}
							<span className="text-muted-foreground">
								They aren't backed up or cleaned up, and the service is pinned
								to the one node that holds them. Only admins can save bind
								mounts.
							</span>
						</p>
					</div>
					<div
						aria-hidden
						className={cn(
							"hidden gap-2 text-sm font-medium sm:grid",
							MOUNT_ROW,
						)}
					>
						<span>Host path</span>
						<span>Container path</span>
					</div>
				</>
			)}
			{mounts.map((m, i) => (
				<MountRow
					// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
					key={i}
					mount={m}
					index={i}
					issues={issues}
					onChange={(next) =>
						setMounts(mounts.map((x, j) => (j === i ? next : x)))
					}
					onRemove={() => setMounts(mounts.filter((_, j) => j !== i))}
				/>
			))}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() =>
						setMounts([...mounts, { kind: "bind", hostPath: "", target: "" }])
					}
				>
					<Plus data-icon="inline-start" />
					Add bind mount
				</Button>
				{mounts.length === 0 && (
					<span className="text-xs text-muted-foreground">
						Admins only. Pins the service to one node.
					</span>
				)}
			</div>
		</div>
	);
}

function CapabilityPicker({
	id,
	label,
	hint,
	value = [],
	onChange,
}: {
	id: string;
	label: string;
	hint: string;
	value: Capability[] | undefined;
	onChange: (caps: Capability[] | undefined) => void;
}) {
	const [open, setOpen] = useState(false);
	const toggle = (c: Capability) =>
		onChange(
			listOrUndefined(
				value.includes(c)
					? value.filter((x) => x !== c)
					: linuxCapabilities.filter((x) => x === c || value.includes(x)),
			),
		);
	return (
		<Field id={id} label={label} hint={hint} optional>
			<div className="flex min-h-9 flex-wrap items-center gap-1.5">
				{value.map((c) => (
					<span
						key={c}
						className="inline-flex h-7 items-center gap-1 rounded-md bg-muted pr-1 pl-2 font-mono text-xs"
					>
						{c}
						<button
							type="button"
							aria-label={`Remove ${c}`}
							onClick={() => toggle(c)}
							className="relative grid size-5 place-items-center rounded-sm text-muted-foreground outline-none transition-colors duration-(--duration-quick) after:absolute after:-inset-1.5 hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						>
							<X className="size-3" aria-hidden />
						</button>
					</span>
				))}
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<Button
							id={id}
							type="button"
							variant="outline"
							size="sm"
							aria-describedby={`${id}-msg`}
						>
							<Plus data-icon="inline-start" />
							{value.length ? "Edit" : "Choose"}
						</Button>
					</PopoverTrigger>
					<PopoverContent className="w-64 p-0" align="start">
						<Command>
							<CommandInput placeholder="Search capabilities" />
							<CommandList>
								<CommandEmpty>No capability matches.</CommandEmpty>
								<CommandGroup>
									{linuxCapabilities.map((c) => (
										<CommandItem
											key={c}
											value={c}
											data-checked={value.includes(c)}
											onSelect={() => toggle(c)}
										>
											<span className="font-mono text-xs">{c}</span>
										</CommandItem>
									))}
								</CommandGroup>
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
			</div>
		</Field>
	);
}

/** User, capabilities and restart policy. */
export function ProcessFields({
	value,
	onChange,
	issues,
	idPrefix,
}: {
	value: HostSettings;
	onChange: Patch;
	issues: SpecIssues;
	idPrefix: string;
}) {
	const userError = value.user ? issueAt(issues, "user") : undefined;
	return (
		<div className="grid gap-5">
			<div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
				<Field
					id={`${idPrefix}user`}
					label="Run as"
					hint="Numeric uid or uid:gid. Empty uses the image's user."
					error={userError ? "Use a uid like 1000 or 1000:1000." : undefined}
					optional
				>
					<Input
						id={`${idPrefix}user`}
						placeholder="1000:1000"
						inputMode="numeric"
						spellCheck={false}
						className="font-mono"
						aria-invalid={userError ? true : undefined}
						aria-describedby={`${idPrefix}user-msg`}
						value={value.user ?? ""}
						onChange={(e) =>
							onChange({ user: e.target.value.trim() || undefined })
						}
					/>
				</Field>
				<div className="grid content-start gap-2">
					<span className="text-sm font-medium">Restart</span>
					<div>
						<Segmented<RestartCondition>
							label="Restart"
							value={value.restart ?? "any"}
							onChange={(r) =>
								onChange({ restart: r === "any" ? undefined : r })
							}
							options={[
								{ value: "any", label: "Always" },
								{ value: "on-failure", label: "On failure" },
								{ value: "none", label: "Never" },
							]}
						/>
					</div>
					<p className="text-xs text-muted-foreground">
						When Swarm starts a replica again after it exits.
					</p>
				</div>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<CapabilityPicker
					id={`${idPrefix}cap-add`}
					label="Add capabilities"
					hint="Kernel privileges beyond Docker's default set."
					value={value.capAdd}
					onChange={(capAdd) => onChange({ capAdd })}
				/>
				<CapabilityPicker
					id={`${idPrefix}cap-drop`}
					label="Drop capabilities"
					hint="Drop ALL, then add back only what the process needs."
					value={value.capDrop}
					onChange={(capDrop) => onChange({ capDrop })}
				/>
			</div>
		</div>
	);
}
