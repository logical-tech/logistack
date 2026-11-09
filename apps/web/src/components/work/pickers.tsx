/*
 * Popover pickers shared by the task sheet, table cells, the bulk bar and the filter builder:
 * one searchable list (cmdk) for statuses, people, priorities, tags, lists and select options,
 * and a date range picker with natural input ("next fri", "in 2 weeks").
 */
import type {
	WorkList,
	WorkPerson,
	WorkPriority,
	WorkStatus,
	WorkTag,
} from "@logistack/contracts";
import { parseHumanDate } from "@logistack/core/work";
import { CalendarDays, Plus, X } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { formatDay, PRIORITIES, todayIso } from "./lib";
import { ColorDot, PersonAvatar, PriorityIcon, StatusIcon } from "./parts";

export type PickerOption = {
	id: string;
	label: string;
	icon?: ReactNode;
	hint?: string;
	keywords?: string[];
};

type PickerProps = {
	options: PickerOption[];
	/** Selected ids. */
	value: readonly string[];
	/** Single: closes on pick and reports one id. */
	multiple?: boolean;
	onChange: (ids: string[]) => void;
	placeholder?: string;
	/** Offers "Create “…”" for a query that matches nothing. */
	onCreate?: (label: string) => void;
	emptyLabel?: string;
	/** A "Clear" row at the end. */
	clearable?: boolean;
};

/** The list inside any picker popover; usable on its own (filter value editors). */
export function OptionList({
	options,
	value,
	multiple,
	onChange,
	placeholder = "Search…",
	onCreate,
	emptyLabel = "Nothing matches.",
	clearable,
	onDone,
}: PickerProps & { onDone?: () => void }) {
	const [q, setQ] = useState("");
	const exact = options.some(
		(o) => o.label.toLowerCase() === q.trim().toLowerCase(),
	);
	const toggle = (id: string) => {
		if (!multiple) {
			onChange([id]);
			onDone?.();
			return;
		}
		onChange(
			value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
		);
	};
	return (
		<Command className="bg-transparent">
			<CommandInput value={q} onValueChange={setQ} placeholder={placeholder} />
			<CommandList className="max-h-72">
				<CommandEmpty>{onCreate ? null : emptyLabel}</CommandEmpty>
				<CommandGroup>
					{options.map((o) => (
						<CommandItem
							key={o.id}
							value={`${o.label} ${o.id}`}
							keywords={o.keywords}
							data-checked={value.includes(o.id)}
							onSelect={() => toggle(o.id)}
						>
							{o.icon}
							<span className="truncate">{o.label}</span>
							{o.hint && (
								<span className="ml-auto pl-2 text-xs text-muted-foreground">
									{o.hint}
								</span>
							)}
						</CommandItem>
					))}
					{onCreate && q.trim() && !exact && (
						<CommandItem
							value={`create ${q}`}
							onSelect={() => {
								onCreate(q.trim());
								setQ("");
							}}
						>
							<Plus />
							Create “{q.trim()}”
						</CommandItem>
					)}
					{clearable && value.length > 0 && (
						<CommandItem
							value="__clear"
							onSelect={() => {
								onChange([]);
								onDone?.();
							}}
						>
							<X /> Clear
						</CommandItem>
					)}
				</CommandGroup>
			</CommandList>
		</Command>
	);
}

/** A trigger plus the option list in a popover. `open`/`onOpenChange` let keyboard shortcuts open it. */
export function Picker({
	trigger,
	open,
	onOpenChange,
	align = "start",
	...props
}: PickerProps & {
	trigger: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	align?: "start" | "center" | "end";
}) {
	const [own, setOwn] = useState(false);
	const isOpen = open ?? own;
	const setOpen = onOpenChange ?? setOwn;
	return (
		<Popover open={isOpen} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent align={align} className="w-64 p-1">
				<OptionList {...props} onDone={() => setOpen(false)} />
			</PopoverContent>
		</Popover>
	);
}

export const statusOptions = (statuses: WorkStatus[]): PickerOption[] =>
	statuses.map((s) => ({
		id: s.id,
		label: s.name,
		icon: <StatusIcon status={s} />,
	}));

export const priorityOptions = (): PickerOption[] =>
	PRIORITIES.map((p) => ({
		id: p.id,
		label: p.label,
		icon: <PriorityIcon priority={p.id as WorkPriority} />,
	}));

export const peopleOptions = (
	people: WorkPerson[],
	opts: { assignableOnly?: boolean; me?: string } = {},
): PickerOption[] =>
	people
		.filter((p) => !opts.assignableOnly || p.assignable)
		.map((p) => ({
			id: p.userId,
			label: p.name,
			icon: <PersonAvatar person={p} />,
			hint: p.userId === opts.me ? "You" : p.guest ? "Guest" : undefined,
			keywords: p.email ? [p.email] : undefined,
		}));

export const tagOptions = (tags: WorkTag[]): PickerOption[] =>
	tags.map((t) => ({
		id: t.id,
		label: t.name,
		icon: <ColorDot color={t.color} />,
	}));

export const listOptions = (lists: WorkList[]): PickerOption[] =>
	lists.map((l) => ({
		id: l.id,
		label: l.name,
		icon: <ColorDot color={l.color} />,
	}));

/** People with avatars; `multiple` for assignees. */
export function PeoplePicker({
	people,
	value,
	onChange,
	multiple = true,
	trigger,
	me,
	open,
	onOpenChange,
}: {
	people: WorkPerson[];
	value: readonly string[];
	onChange: (ids: string[]) => void;
	multiple?: boolean;
	trigger: ReactNode;
	me?: string;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const options = useMemo(
		() => peopleOptions(people, { assignableOnly: true, me }),
		[people, me],
	);
	return (
		<Picker
			trigger={trigger}
			options={options}
			value={value}
			multiple={multiple}
			onChange={onChange}
			placeholder="Assign to…"
			emptyLabel="No one by that name can be assigned here."
			clearable={!multiple}
			open={open}
			onOpenChange={onOpenChange}
		/>
	);
}

/** `null` when the text is not a date; ISO dates pass through. */
export const parseDayInput = (text: string): string | null =>
	parseHumanDate(
		text,
		new Date(),
		Intl.DateTimeFormat().resolvedOptions().timeZone,
	)?.date ?? null;

function DayField({
	label,
	value,
	onChange,
	autoFocus,
}: {
	label: string;
	value: string | null;
	onChange: (v: string | null) => void;
	autoFocus?: boolean;
}) {
	const id = useId();
	const [text, setText] = useState(value ? formatDay(value) : "");
	const [invalid, setInvalid] = useState(false);
	const commit = () => {
		if (!text.trim()) {
			setInvalid(false);
			onChange(null);
			return;
		}
		const parsed = parseDayInput(text);
		setInvalid(!parsed);
		if (parsed) {
			onChange(parsed);
			setText(formatDay(parsed));
		}
	};
	return (
		<div className="grid gap-1">
			<label htmlFor={id} className="text-xs text-muted-foreground">
				{label}
			</label>
			<div className="flex gap-1.5">
				<Input
					id={id}
					autoFocus={autoFocus}
					value={text}
					placeholder="next fri, in 2 weeks, 3 dec"
					aria-invalid={invalid || undefined}
					aria-describedby={invalid ? `${id}-err` : undefined}
					onChange={(e) => setText(e.target.value)}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commit();
						}
					}}
				/>
				<input
					type="date"
					aria-label={`${label}, calendar`}
					value={value ?? ""}
					onChange={(e) => {
						const v = e.target.value || null;
						onChange(v);
						setText(v ? formatDay(v) : "");
						setInvalid(false);
					}}
					className="w-9 shrink-0 cursor-pointer rounded-md border bg-transparent px-1.5 text-transparent [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:m-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60"
				/>
			</div>
			{invalid && (
				<p id={`${id}-err`} className="text-xs text-bad-text">
					Not a date. Try “tomorrow”, “fri” or “12 dec”.
				</p>
			)}
		</div>
	);
}

export type DateRange = {
	startDate: string | null;
	dueDate: string | null;
	dueTime?: string | null;
};

/** Start, due and due time, typed in plain words or picked on a calendar. */
export function DateRangePicker({
	value,
	onChange,
	trigger,
	open,
	onOpenChange,
	withTime = true,
	extra,
}: {
	value: DateRange;
	onChange: (v: DateRange) => void;
	trigger: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	withTime?: boolean;
	/** Rows under the dates (the Repeat row). */
	extra?: ReactNode;
}) {
	const [own, setOwn] = useState(false);
	const isOpen = open ?? own;
	const setOpen = onOpenChange ?? setOwn;
	const [error, setError] = useState<string | null>(null);
	const timeId = useId();
	const apply = (next: DateRange) => {
		if (next.startDate && next.dueDate && next.startDate > next.dueDate) {
			setError("The start can't be after the due date.");
			return;
		}
		setError(null);
		// Only the three date fields: callers pass a whole task as `value`, and spreading it would
		// send every field (dependencies included) as the patch.
		onChange({
			startDate: next.startDate,
			dueDate: next.dueDate,
			dueTime: next.dueDate ? (next.dueTime ?? null) : null,
		});
	};
	return (
		<Popover open={isOpen} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent align="start" className="w-80 gap-3 p-3">
				{isOpen && (
					<>
						<DayField
							label="Start"
							value={value.startDate}
							onChange={(startDate) => apply({ ...value, startDate })}
						/>
						<DayField
							label="Due"
							autoFocus
							value={value.dueDate}
							onChange={(dueDate) => apply({ ...value, dueDate })}
						/>
						{withTime && value.dueDate && (
							<div className="grid gap-1 text-xs text-muted-foreground">
								<label htmlFor={`${timeId}-time`}>Due time</label>
								<Input
									id={`${timeId}-time`}
									type="time"
									value={value.dueTime ?? ""}
									onChange={(e) =>
										apply({ ...value, dueTime: e.target.value || null })
									}
									className="w-32"
								/>
							</div>
						)}
						{error && (
							<p role="alert" className="text-xs text-bad-text">
								{error}
							</p>
						)}
						<div className="flex flex-wrap gap-1">
							{[
								["Today", todayIso()],
								["Tomorrow", parseDayInput("tomorrow")],
								["Next week", parseDayInput("next week")],
							].map(([label, d]) => (
								<Button
									key={label}
									size="sm"
									variant="outline"
									onClick={() => apply({ ...value, dueDate: d ?? null })}
								>
									{label}
								</Button>
							))}
							{(value.startDate || value.dueDate) && (
								<Button
									size="sm"
									variant="ghost"
									className="ml-auto text-muted-foreground"
									onClick={() =>
										apply({ startDate: null, dueDate: null, dueTime: null })
									}
								>
									Clear
								</Button>
							)}
						</div>
						{extra}
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}

/** "12 Nov → 3 Dec", "Due Fri", or the placeholder. */
export function DateRangeLabel({
	value,
	placeholder = "No dates",
	className,
}: {
	value: DateRange;
	placeholder?: string;
	className?: string;
}) {
	const { startDate, dueDate, dueTime } = value;
	return (
		<span className={cn("inline-flex items-center gap-1.5 tabular", className)}>
			<CalendarDays className="size-3.5 text-muted-foreground" aria-hidden />
			{!startDate && !dueDate ? (
				<span className="text-muted-foreground">{placeholder}</span>
			) : startDate && dueDate && startDate !== dueDate ? (
				`${formatDay(startDate)} → ${formatDay(dueDate)}`
			) : dueDate ? (
				`${formatDay(dueDate)}${dueTime ? ` ${dueTime}` : ""}`
			) : (
				`From ${formatDay(startDate)}`
			)}
		</span>
	);
}
