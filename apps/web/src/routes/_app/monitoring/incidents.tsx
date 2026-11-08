import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarClock, Megaphone, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { MonitoringPage } from "@/components/monitoring/monitoring-page";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusLabel } from "@/components/status";
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
import { Textarea } from "@/components/ui/textarea";
import { MonitorPicker } from "@/components/uptime/monitor-picker";
import { IMPACT_LABEL, INCIDENT_STATUS } from "@/components/uptime/parts";
import { useInvalidating } from "@/lib/api/networking";
import {
	type Incident,
	type IncidentImpact,
	type IncidentStatus,
	incidentsQuery,
	type MaintenanceWindow,
	maintenanceQuery,
	monitorsQuery,
	uptimeApi,
} from "@/lib/api/uptime";

export const Route = createFileRoute("/_app/monitoring/incidents")({
	staticData: { crumb: "Incidents" },
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(incidentsQuery);
	},
	component: Incidents,
});

const STATUSES = Object.keys(INCIDENT_STATUS) as IncidentStatus[];
const IMPACTS = Object.keys(IMPACT_LABEL) as IncidentImpact[];

const when = (iso: string) =>
	new Date(iso).toLocaleString(undefined, {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

function StatusSelect({
	id,
	value,
	onChange,
}: {
	id: string;
	value: IncidentStatus;
	onChange: (s: IncidentStatus) => void;
}) {
	return (
		<Select value={value} onValueChange={(v) => onChange(v as IncidentStatus)}>
			<SelectTrigger id={id} className="w-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{STATUSES.map((s) => (
					<SelectItem key={s} value={s}>
						{INCIDENT_STATUS[s].label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function ReportDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const { data: monitors = [] } = useQuery(monitorsQuery);
	const create = useInvalidating(uptimeApi.createIncident, [["incidents"]]);
	const [title, setTitle] = useState("");
	const [impact, setImpact] = useState<IncidentImpact>("major");
	const [status, setStatus] = useState<IncidentStatus>("investigating");
	const [monitorIds, setMonitorIds] = useState<string[]>([]);
	const [message, setMessage] = useState("");
	const submit = (e: FormEvent) => {
		e.preventDefault();
		create.mutate(
			{
				title: title.trim(),
				impact,
				status,
				monitorIds,
				message: message.trim(),
			},
			{
				onSuccess: () => {
					toast.success("Incident posted", {
						description: "Status pages listing these monitors show it now.",
					});
					onOpenChange(false);
					setTitle("");
					setMessage("");
					setMonitorIds([]);
				},
				onError: (e) => toast.error(e.message),
			},
		);
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} className="grid gap-5">
					<DialogHeader>
						<DialogTitle>Report an incident</DialogTitle>
						<DialogDescription>
							Appears on every status page that lists an affected monitor.
						</DialogDescription>
					</DialogHeader>
					<Field id="inc-title" label="Title">
						<Input
							id="inc-title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Checkout is slow"
							required
							maxLength={200}
							autoFocus
						/>
					</Field>
					<div className="grid gap-4 sm:grid-cols-2">
						<Field id="inc-status" label="Status">
							<StatusSelect
								id="inc-status"
								value={status}
								onChange={setStatus}
							/>
						</Field>
						<Field id="inc-impact" label="Impact">
							<Select
								value={impact}
								onValueChange={(v) => setImpact(v as IncidentImpact)}
							>
								<SelectTrigger id="inc-impact" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{IMPACTS.map((i) => (
										<SelectItem key={i} value={i}>
											{IMPACT_LABEL[i]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					</div>
					<Field id="inc-monitors" label="Affected monitors" optional>
						<MonitorPicker
							idPrefix="inc-mon"
							monitors={monitors}
							value={monitorIds}
							onChange={setMonitorIds}
						/>
					</Field>
					<Field
						id="inc-message"
						label="First update"
						hint="What people see. Plain words, no internals."
					>
						<Textarea
							id="inc-message"
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							rows={3}
							required
							placeholder="We are looking into slow checkouts."
						/>
					</Field>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={create.isPending || !title.trim() || !message.trim()}
						>
							Post incident
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function UpdateForm({
	incident,
	onDone,
}: {
	incident: Incident;
	onDone: () => void;
}) {
	const post = useInvalidating(uptimeApi.postIncidentUpdate, [["incidents"]]);
	const [status, setStatus] = useState<IncidentStatus>(incident.status);
	const [message, setMessage] = useState("");
	const id = `upd-${incident.id}`;
	return (
		<form
			className="t-reveal grid gap-3 rounded-lg bg-muted/50 p-3 dark:bg-muted/30"
			onSubmit={(e) => {
				e.preventDefault();
				post.mutate(
					{ id: incident.id, json: { status, message: message.trim() } },
					{
						onSuccess: () => {
							toast.success(
								status === "resolved" ? "Incident resolved" : "Update posted",
							);
							onDone();
						},
						onError: (e) => toast.error(e.message),
					},
				);
			}}
		>
			<div className="grid gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
				<Field id={`${id}-status`} label="Status">
					<StatusSelect
						id={`${id}-status`}
						value={status}
						onChange={setStatus}
					/>
				</Field>
				<Field id={`${id}-msg`} label="Update">
					<Textarea
						id={`${id}-msg`}
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						rows={2}
						required
						autoFocus
					/>
				</Field>
			</div>
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onDone}>
					Cancel
				</Button>
				<Button
					type="submit"
					size="sm"
					disabled={post.isPending || !message.trim()}
				>
					Post update
				</Button>
			</div>
		</form>
	);
}

function IncidentItem({
	i,
	names,
}: {
	i: Incident;
	names: Map<string, string>;
}) {
	const [updating, setUpdating] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const remove = useInvalidating(uptimeApi.removeIncident, [["incidents"]]);
	const affected = i.monitorIds.map((id) => names.get(id) ?? "deleted monitor");
	return (
		<li className="grid gap-3 px-4 py-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="font-medium text-balance">{i.title}</h3>
					<p className="mt-0.5 text-xs text-muted-foreground tabular">
						{IMPACT_LABEL[i.impact]} impact · {when(i.startedAt)}
						{i.resolvedAt && ` – ${when(i.resolvedAt)}`}
						{affected.length > 0 && ` · ${affected.join(", ")}`}
						{i.openedByMonitorId && " · opened automatically"}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<StatusLabel meta={INCIDENT_STATUS[i.status]} />
					{!i.resolvedAt && !updating && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setUpdating(true)}
						>
							Post update
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						className="text-muted-foreground"
						onClick={() => setConfirm(true)}
					>
						Delete
					</Button>
				</div>
			</div>
			{updating && (
				<UpdateForm incident={i} onDone={() => setUpdating(false)} />
			)}
			<ol className="grid gap-3 border-l-2 pl-4">
				{i.updates.map((u) => (
					<li key={u.id} className="grid gap-0.5">
						<p className="text-xs text-muted-foreground">
							<span className="font-medium text-foreground">
								{INCIDENT_STATUS[u.status].label}
							</span>{" "}
							<time dateTime={u.createdAt} className="tabular">
								{when(u.createdAt)}
							</time>
						</p>
						<p className="text-sm text-pretty whitespace-pre-wrap">
							{u.message}
						</p>
					</li>
				))}
			</ol>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title="Delete this incident?"
				description="It disappears from every status page, with its updates. Resolve it instead to keep the history."
				confirmLabel="Delete incident"
				pending={remove.isPending}
				onConfirm={() =>
					remove.mutate(i.id, {
						onSuccess: () => setConfirm(false),
						onError: (e) => toast.error(e.message),
					})
				}
			/>
		</li>
	);
}

/** `datetime-local` value for a date, in the browser's zone. */
const localInput = (d: Date) =>
	new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
		.toISOString()
		.slice(0, 16);

function MaintenanceDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const { data: monitors = [] } = useQuery(monitorsQuery);
	const create = useInvalidating(uptimeApi.createWindow, [
		["maintenance-windows"],
	]);
	const start = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [startsAt, setStartsAt] = useState(() => localInput(start));
	const [endsAt, setEndsAt] = useState(() =>
		localInput(new Date(start.getTime() + 3_600_000)),
	);
	const [repeat, setRepeat] = useState<MaintenanceWindow["repeat"]>("none");
	const [monitorIds, setMonitorIds] = useState<string[]>([]);
	const order = new Date(endsAt) > new Date(startsAt);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<form
					className="grid gap-5"
					onSubmit={(e) => {
						e.preventDefault();
						create.mutate(
							{
								title: title.trim(),
								description: description.trim(),
								monitorIds,
								startsAt: new Date(startsAt).toISOString(),
								endsAt: new Date(endsAt).toISOString(),
								repeat,
							},
							{
								onSuccess: () => {
									toast.success("Maintenance scheduled");
									onOpenChange(false);
									setTitle("");
									setMonitorIds([]);
								},
								onError: (e) => toast.error(e.message),
							},
						);
					}}
				>
					<DialogHeader>
						<DialogTitle>Schedule maintenance</DialogTitle>
						<DialogDescription>
							While it runs, the listed monitors show Maintenance, send no
							alerts and their checks leave uptime untouched.
						</DialogDescription>
					</DialogHeader>
					<Field id="mtw-title" label="Title">
						<Input
							id="mtw-title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							required
							maxLength={200}
							autoFocus
							placeholder="Database upgrade"
						/>
					</Field>
					<div className="grid gap-4 sm:grid-cols-2">
						<Field id="mtw-start" label="Starts">
							<Input
								id="mtw-start"
								type="datetime-local"
								value={startsAt}
								onChange={(e) => setStartsAt(e.target.value)}
								required
							/>
						</Field>
						<Field
							id="mtw-end"
							label="Ends"
							error={order ? undefined : "Must end after it starts."}
						>
							<Input
								id="mtw-end"
								type="datetime-local"
								value={endsAt}
								onChange={(e) => setEndsAt(e.target.value)}
								required
								aria-invalid={!order || undefined}
							/>
						</Field>
					</div>
					<Field id="mtw-repeat" label="Repeats">
						<Select
							value={repeat}
							onValueChange={(v) => setRepeat(v as MaintenanceWindow["repeat"])}
						>
							<SelectTrigger id="mtw-repeat" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="none">Once</SelectItem>
								<SelectItem value="daily">Every day</SelectItem>
								<SelectItem value="weekly">Every week</SelectItem>
							</SelectContent>
						</Select>
					</Field>
					<Field id="mtw-monitors" label="Monitors" hint="Pick at least one.">
						<MonitorPicker
							idPrefix="mtw-mon"
							monitors={monitors}
							value={monitorIds}
							onChange={setMonitorIds}
						/>
					</Field>
					<Field id="mtw-desc" label="Note for status pages" optional>
						<Textarea
							id="mtw-desc"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={2}
						/>
					</Field>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={
								create.isPending ||
								!title.trim() ||
								monitorIds.length === 0 ||
								!order
							}
						>
							Schedule
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

const REPEAT_LABEL = {
	none: "Once",
	daily: "Every day",
	weekly: "Every week",
} as const;

function Incidents() {
	const { data: incidents } = useQuery(incidentsQuery);
	const { data: windows } = useQuery(maintenanceQuery);
	const { data: monitors = [] } = useQuery(monitorsQuery);
	const removeWindow = useInvalidating(uptimeApi.removeWindow, [
		["maintenance-windows"],
	]);
	const [reporting, setReporting] = useState(false);
	const [scheduling, setScheduling] = useState(false);
	const names = new Map(monitors.map((m) => [m.id, m.name]));
	const open = incidents?.filter((i) => !i.resolvedAt) ?? [];
	const past = incidents?.filter((i) => i.resolvedAt) ?? [];

	return (
		<MonitoringPage
			section="incidents"
			description="What your status pages say about outages and planned work. Monitors open and resolve incidents on their own."
			action={
				<Button onClick={() => setReporting(true)}>
					<Plus data-icon="inline-start" />
					Report incident
				</Button>
			}
		>
			<div className="grid gap-8">
				{incidents && incidents.length === 0 ? (
					<EmptyState
						icon={Megaphone}
						title="No incidents"
						description="When a monitor goes down it opens one here. You can also report one by hand, for problems no check sees."
					/>
				) : (
					<>
						<Panel id="open-heading" title="Open">
							{!incidents ? (
								<SkeletonRows rows={2} />
							) : open.length === 0 ? (
								<p className="px-4 py-6 text-sm text-muted-foreground">
									Nothing open. Every monitored service is answering.
								</p>
							) : (
								<ul className="divide-y">
									{open.map((i) => (
										<IncidentItem key={i.id} i={i} names={names} />
									))}
								</ul>
							)}
						</Panel>
						{past.length > 0 && (
							<Panel id="past-heading" title="Resolved">
								<ul className="divide-y">
									{past.map((i) => (
										<IncidentItem key={i.id} i={i} names={names} />
									))}
								</ul>
							</Panel>
						)}
					</>
				)}

				<Panel
					id="maintenance-heading"
					title="Maintenance"
					actions={
						<Button
							variant="outline"
							size="sm"
							onClick={() => setScheduling(true)}
						>
							<CalendarClock data-icon="inline-start" />
							Schedule
						</Button>
					}
				>
					{!windows ? (
						<SkeletonRows rows={2} />
					) : windows.length === 0 ? (
						<p className="px-4 py-6 text-sm text-muted-foreground">
							No maintenance planned. Schedule a window so planned downtime does
							not alert anyone or count against uptime.
						</p>
					) : (
						<ul className="divide-y">
							{windows.map((w) => (
								<li
									key={w.id}
									className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
								>
									<div className="min-w-0 flex-1">
										<p className="flex items-center gap-2 text-sm font-medium">
											{w.title}
											{w.active && (
												<span className="rounded-sm bg-info/15 px-1.5 py-px text-2xs font-medium text-info-text">
													In progress
												</span>
											)}
										</p>
										<p className="text-xs text-muted-foreground tabular">
											{when(w.startsAt)} – {when(w.endsAt)} ·{" "}
											{REPEAT_LABEL[w.repeat]} ·{" "}
											{w.monitorIds
												.map((id) => names.get(id) ?? "deleted")
												.join(", ")}
										</p>
									</div>
									<Button
										variant="ghost"
										size="sm"
										className="text-muted-foreground"
										disabled={removeWindow.isPending}
										onClick={() =>
											removeWindow.mutate(w.id, {
												onSuccess: () => toast.success(`${w.title} removed`),
												onError: (e) => toast.error(e.message),
											})
										}
									>
										Remove
									</Button>
								</li>
							))}
						</ul>
					)}
				</Panel>
			</div>
			<ReportDialog open={reporting} onOpenChange={setReporting} />
			<MaintenanceDialog open={scheduling} onOpenChange={setScheduling} />
		</MonitoringPage>
	);
}
