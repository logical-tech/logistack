/* Small display atoms shared by every Work screen. */
import type {
	WorkColor,
	WorkHealth,
	WorkPerson,
	WorkPriority,
	WorkStatus,
	WorkStatusCategory,
	WorkTag,
} from "@logistack/contracts";
import { CircleDashed, Signal, SignalHigh, SignalLow } from "lucide-react";
import { StatusDot } from "@/components/status";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { TONE_TEXT } from "@/lib/status";
import { cn } from "@/lib/utils";
import {
	dueTone,
	formatDay,
	HEALTH,
	healthLabel,
	initials,
	priorityMeta,
	wc,
} from "./lib";

/** The status glyph: an empty ring for backlog, a half for active, filled for done, struck for cancelled. */
export function StatusIcon({
	status,
	className,
}: {
	status: Pick<WorkStatus, "color" | "category"> | undefined;
	className?: string;
}) {
	const category: WorkStatusCategory = status?.category ?? "backlog";
	return (
		<svg
			viewBox="0 0 14 14"
			aria-hidden
			style={wc(status?.color)}
			className={cn("size-3.5 shrink-0 text-(--wc)", className)}
		>
			<circle
				cx="7"
				cy="7"
				r="5.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeDasharray={category === "backlog" ? "2.2 1.6" : undefined}
			/>
			{category === "active" && (
				<path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
			)}
			{category === "done" && (
				<>
					<circle cx="7" cy="7" r="5.5" fill="currentColor" />
					<path
						d="M4.6 7.2 6.3 8.8 9.4 5.4"
						fill="none"
						stroke="var(--background)"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</>
			)}
			{category === "cancelled" && (
				<path
					d="M4.8 4.8l4.4 4.4M9.2 4.8 4.8 9.2"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
				/>
			)}
		</svg>
	);
}

export function StatusPill({
	status,
	className,
}: {
	status: WorkStatus | undefined;
	className?: string;
}) {
	return (
		<span
			style={wc(status?.color)}
			className={cn(
				"inline-flex h-6 max-w-full items-center gap-1.5 rounded-full bg-(--wc)/12 px-2 text-xs font-medium whitespace-nowrap text-(--wc-text)",
				className,
			)}
		>
			<StatusIcon status={status} className="size-3" />
			<span className="truncate">{status?.name ?? "No status"}</span>
		</span>
	);
}

const PRIORITY_ICON = {
	urgent: null,
	high: SignalHigh,
	normal: Signal,
	low: SignalLow,
	none: CircleDashed,
} as const;

export function PriorityIcon({
	priority,
	className,
}: {
	priority: WorkPriority;
	className?: string;
}) {
	const meta = priorityMeta(priority);
	if (priority === "urgent")
		return (
			<span
				role="img"
				aria-label={meta.label}
				className={cn(
					"grid size-3.5 shrink-0 place-items-center rounded-[3px] bg-bad text-[10px] leading-none font-bold text-white",
					className,
				)}
			>
				!
			</span>
		);
	const Icon = PRIORITY_ICON[priority];
	return (
		<Icon
			role="img"
			aria-label={meta.label}
			strokeWidth={2}
			className={cn(
				"size-3.5 shrink-0",
				meta.tone ? TONE_TEXT[meta.tone] : "text-muted-foreground/60",
				className,
			)}
		/>
	);
}

export function PersonAvatar({
	person,
	className,
}: {
	person: Pick<WorkPerson, "name" | "avatar"> | undefined;
	className?: string;
}) {
	return (
		<Avatar className={cn("size-5 text-[9px]", className)}>
			{person?.avatar && <AvatarImage src={person.avatar} alt="" />}
			<AvatarFallback className="bg-muted font-semibold text-muted-foreground">
				{initials(person?.name ?? "Former member")}
			</AvatarFallback>
		</Avatar>
	);
}

/** Up to `max` avatars overlapped, then "+n"; the tooltip names everyone. */
export function AvatarStack({
	people,
	ids,
	max = 3,
	className,
}: {
	people: WorkPerson[];
	ids: readonly string[];
	max?: number;
	className?: string;
}) {
	if (!ids.length) return null;
	const named = ids.map(
		(id) =>
			people.find((p) => p.userId === id) ?? {
				userId: id,
				name: "Former member",
				avatar: null,
			},
	);
	const names = named.map((p) => p.name).join(", ");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					role="img"
					aria-label={names}
					className={cn("flex items-center -space-x-1.5", className)}
				>
					{named.slice(0, max).map((p) => (
						<PersonAvatar
							key={p.userId}
							person={p}
							className="ring-2 ring-background"
						/>
					))}
					{named.length > max && (
						<span className="grid size-5 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground tabular ring-2 ring-background">
							+{named.length - max}
						</span>
					)}
				</span>
			</TooltipTrigger>
			<TooltipContent>{names}</TooltipContent>
		</Tooltip>
	);
}

export function ColorChip({
	color,
	children,
	className,
}: {
	color: WorkColor | null | undefined;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<span
			style={wc(color)}
			className={cn(
				"inline-flex h-5 max-w-40 items-center gap-1 rounded-md bg-(--wc)/12 px-1.5 text-xs whitespace-nowrap text-(--wc-text)",
				className,
			)}
		>
			<span className="truncate">{children}</span>
		</span>
	);
}

export function TagChips({
	tags,
	ids,
	max = 3,
}: {
	tags: WorkTag[];
	ids: readonly string[];
	max?: number;
}) {
	const list = ids.flatMap((id) => tags.filter((t) => t.id === id));
	if (!list.length) return null;
	return (
		<span className="flex min-w-0 items-center gap-1">
			{list.slice(0, max).map((t) => (
				<ColorChip key={t.id} color={t.color}>
					{t.name}
				</ColorChip>
			))}
			{list.length > max && (
				<span className="text-xs text-muted-foreground tabular">
					+{list.length - max}
				</span>
			)}
		</span>
	);
}

export function ColorDot({
	color,
	className,
}: {
	color: WorkColor | null | undefined;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			style={wc(color)}
			className={cn("size-2 shrink-0 rounded-full bg-(--wc)", className)}
		/>
	);
}

/** "Today", "12 Nov", red when overdue on an open task. */
export function DueDate({
	date,
	closed,
	className,
}: {
	date: string | null;
	closed: boolean;
	className?: string;
}) {
	if (!date) return null;
	const tone = dueTone(date, closed);
	return (
		<span
			className={cn(
				"text-xs whitespace-nowrap tabular",
				tone === "overdue"
					? "font-medium text-bad-text"
					: tone === "today"
						? "font-medium text-warn-text"
						: "text-muted-foreground",
				className,
			)}
		>
			{formatDay(date)}
			{tone === "overdue" && <span className="sr-only"> (overdue)</span>}
		</span>
	);
}

export function HealthDot({ health }: { health: WorkHealth }) {
	const meta = HEALTH[health];
	return (
		<StatusDot
			meta={{
				label: meta.label,
				tone: meta.tone,
				live: health === "down",
			}}
		/>
	);
}

export function HealthPill({
	health,
	since,
	className,
}: {
	health: WorkHealth;
	since: string | null;
	className?: string;
}) {
	const meta = HEALTH[health];
	return (
		<span
			className={cn(
				"inline-flex items-center gap-2 text-sm font-medium",
				TONE_TEXT[meta.tone],
				className,
			)}
		>
			<HealthDot health={health} />
			{healthLabel(health, since)}
		</span>
	);
}

export function TaskKey({
	value,
	className,
}: {
	value: string;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"text-xs whitespace-nowrap text-muted-foreground tabular",
				className,
			)}
		>
			{value}
		</span>
	);
}
