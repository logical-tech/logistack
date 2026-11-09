import type {
	WorkEmailMode,
	WorkNotificationKind,
	WorkPrefsUpdate,
} from "@logistack/contracts";
import { BellOff, CalendarDays, Inbox, Mail, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ChoiceGroup } from "@/components/wizard/parts";
import {
	useRotateWorkIcal,
	useUpdateWorkPrefs,
	useWorkPrefs,
} from "@/lib/api/work-queries";

/** Account → Notifications: Work email mode, which kinds, the digest hour, time zone and iCal link. */

const KINDS: { kind: WorkNotificationKind; label: string; hint: string }[] = [
	{
		kind: "assigned",
		label: "Assigned to you",
		hint: "Someone gives you a task",
	},
	{ kind: "mentioned", label: "Mentions", hint: "Someone @mentions you" },
	{ kind: "replied", label: "Replies", hint: "Answers in a thread you're in" },
	{ kind: "commented", label: "Comments", hint: "On tasks you watch" },
	{
		kind: "status_changed",
		label: "Status changes",
		hint: "Watched tasks done, cancelled or reopened",
	},
	{
		kind: "due_soon",
		label: "Due soon",
		hint: "The day a task of yours is due",
	},
	{ kind: "overdue", label: "Overdue", hint: "The morning after it was due" },
	{
		kind: "checklist_assigned",
		label: "Checklist items",
		hint: "An item assigned to you",
	},
];

const HOURS = Array.from({ length: 24 }, (_, h) => ({
	value: String(h),
	label: `${String(h).padStart(2, "0")}:00`,
}));

function zones(): string[] {
	try {
		return Intl.supportedValuesOf("timeZone");
	} catch {
		return ["UTC"];
	}
}

function CalendarFeed({ enabled }: { enabled: boolean }) {
	const rotate = useRotateWorkIcal();
	const [url, setUrl] = useState<string>();
	const create = () =>
		rotate.mutate(undefined, {
			onSuccess: (r) => setUrl(r.url),
			onError: (err) =>
				toast.error("Couldn't create the link", { description: err.message }),
		});
	return (
		<div className="grid gap-4 p-4">
			<p className="max-w-[68ch] text-sm text-pretty text-muted-foreground">
				Your tasks with due dates, in Google Calendar, Apple Calendar or
				Outlook. The link works without signing in, so treat it like a password;
				making a new one stops the old one.
			</p>
			{url ? (
				<div key={url} className="t-swap grid gap-2">
					<Label htmlFor="ical-url" className="text-sm">
						Subscribe to this URL
					</Label>
					<div className="flex gap-2">
						<Input
							id="ical-url"
							readOnly
							value={url}
							className="font-mono text-[13px]"
							onFocus={(e) => e.currentTarget.select()}
						/>
						<CopyButton value={url} label="Copy calendar link" />
					</div>
					<p className="text-xs text-muted-foreground">
						Shown once. Copy it now.
					</p>
				</div>
			) : (
				<div className="flex items-center justify-between gap-3">
					<span className="text-sm">
						{enabled ? "A calendar link is active." : "No calendar link yet."}
					</span>
					<Button
						type="button"
						variant="outline"
						onClick={create}
						disabled={rotate.isPending}
					>
						{enabled ? "Replace link" : "Create link"}
					</Button>
				</div>
			)}
		</div>
	);
}

export function NotificationPrefs() {
	const { data: prefs } = useWorkPrefs();
	const update = useUpdateWorkPrefs();
	const allZones = useMemo(zones, []);
	if (!prefs) return <SkeletonRows rows={5} />;

	const save = (patch: WorkPrefsUpdate) =>
		update.mutate(patch, {
			onError: (err) =>
				toast.error("Settings not saved", { description: err.message }),
		});
	const toggleKind = (kind: WorkNotificationKind, on: boolean) =>
		save({
			emailKinds: on
				? [...prefs.emailKinds, kind]
				: prefs.emailKinds.filter((k) => k !== kind),
		});
	const emailOn = prefs.mailAvailable && prefs.email !== "off";

	return (
		<div className="grid gap-8">
			<Panel title="Email" bodyClassName="p-4">
				<div className="grid gap-4">
					{!prefs.mailAvailable && (
						<div className="flex items-start gap-3 rounded-lg bg-muted/60 px-3.5 py-3 text-sm dark:bg-muted/40">
							<Mail
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							<p className="text-pretty">
								<span className="font-medium">
									This server doesn't send email yet.
								</span>{" "}
								<span className="text-muted-foreground">
									Ask an admin to set up instance email. Notifications still
									arrive in your inbox.
								</span>
							</p>
						</div>
					)}
					<fieldset
						disabled={!prefs.mailAvailable}
						className="min-w-0 disabled:opacity-60 [&_[role=radiogroup]]:sm:grid-cols-3"
					>
						<legend className="sr-only">Email notifications</legend>
						<ChoiceGroup<WorkEmailMode>
							label="Email notifications"
							columns={2}
							value={prefs.mailAvailable ? prefs.email : "off"}
							onChange={(email) => save({ email })}
							choices={[
								{
									value: "off",
									title: "Off",
									description: "Inbox only",
									icon: BellOff,
								},
								{
									value: "instant",
									title: "Instant",
									description: "A few minutes after, unless you've read it",
									icon: Zap,
								},
								{
									value: "daily",
									title: "Daily digest",
									description: "One email a day, skipped when empty",
									icon: Inbox,
								},
							]}
						/>
					</fieldset>
				</div>
			</Panel>

			{emailOn && (
				<Panel title="What to email" className="t-reveal" bodyClassName="p-2">
					<ul className="grid gap-1 sm:grid-cols-2">
						{KINDS.map(({ kind, label, hint }) => (
							<li key={kind}>
								<label
									htmlFor={`kind-${kind}`}
									className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/60"
								>
									<Checkbox
										id={`kind-${kind}`}
										checked={prefs.emailKinds.includes(kind)}
										onCheckedChange={(on) => toggleKind(kind, on === true)}
										className="mt-0.5"
									/>
									<span className="min-w-0 text-sm">
										<span className="font-medium">{label}</span>
										<span className="block text-xs text-muted-foreground">
											{hint}
										</span>
									</span>
								</label>
							</li>
						))}
					</ul>
				</Panel>
			)}

			<Panel title="Timing" bodyClassName="p-4">
				<div className="grid gap-5 sm:grid-cols-2">
					<div className="grid content-start gap-2">
						<Label htmlFor="prefs-hour" className="text-sm">
							Morning hour
						</Label>
						<Select
							value={String(prefs.dailyHour)}
							onValueChange={(v) => save({ dailyHour: Number(v) })}
						>
							<SelectTrigger id="prefs-hour" className="w-full tabular-nums">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{HOURS.map((h) => (
									<SelectItem
										key={h.value}
										value={h.value}
										className="tabular-nums"
									>
										{h.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-xs text-muted-foreground">
							When the digest goes out and due-date reminders fire.
						</p>
					</div>
					<div className="grid content-start gap-2">
						<Label htmlFor="prefs-tz" className="text-sm">
							Time zone
						</Label>
						<Select
							value={prefs.timezone ?? "_default"}
							onValueChange={(v) =>
								save({ timezone: v === "_default" ? null : v })
							}
						>
							<SelectTrigger id="prefs-tz" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent className="max-h-80">
								<SelectItem value="_default">UTC (default)</SelectItem>
								{allZones.map((z) => (
									<SelectItem key={z} value={z}>
										{z.replaceAll("_", " ")}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-xs text-muted-foreground">
							Used for "due today" and the morning hour.
						</p>
					</div>
				</div>
			</Panel>

			<Panel
				title={
					<span className="flex items-center gap-2">
						<CalendarDays className="size-4" strokeWidth={1.75} aria-hidden />
						Calendar feed
					</span>
				}
			>
				<CalendarFeed enabled={prefs.icalEnabled} />
			</Panel>
		</div>
	);
}
