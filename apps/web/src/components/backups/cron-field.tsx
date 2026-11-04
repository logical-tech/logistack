import { ChevronsUpDown } from "lucide-react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	type CronEvery,
	cronError,
	describeCron,
	formatInZone,
	fromCron,
	nextRuns,
	type SimpleCron,
	switchEvery,
	timezones,
	toCron,
} from "@/lib/cron";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Mode = "simple" | "cron";

const EVERY: { value: CronEvery; label: string }[] = [
	{ value: "minutes", label: "Minutes" },
	{ value: "hours", label: "Hourly" },
	{ value: "day", label: "Daily" },
	{ value: "week", label: "Weekly" },
	{ value: "month", label: "Monthly" },
];

const MINUTE_STEPS = [1, 5, 10, 15, 20, 30];
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
/** Monday first, as people read a week; values are cron's 0 = Sunday. */
const WEEK = [
	{ value: 1, short: "Mon", long: "Monday" },
	{ value: 2, short: "Tue", long: "Tuesday" },
	{ value: 3, short: "Wed", long: "Wednesday" },
	{ value: 4, short: "Thu", long: "Thursday" },
	{ value: 5, short: "Fri", long: "Friday" },
	{ value: 6, short: "Sat", long: "Saturday" },
	{ value: 0, short: "Sun", long: "Sunday" },
];

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * A schedule as a visual form (frequency, days, time) or as a raw cron expression,
 * with its meaning in words, its next runs, and (optionally) its time zone.
 */
export function CronField({
	id,
	label,
	cron,
	timezone,
	onCron,
	onTimezone,
	error,
	hint,
}: {
	id: string;
	label: string;
	cron: string;
	timezone: string;
	onCron: (cron: string) => void;
	/** Omit to share a zone picked elsewhere (a verify cron uses its policy's). */
	onTimezone?: (tz: string) => void;
	error?: string;
	hint?: string;
}) {
	const input = useRef<HTMLInputElement>(null);
	const simple = fromCron(cron);
	const [mode, setMode] = useState<Mode>(
		simple || !cron.trim() ? "simple" : "cron",
	);
	const words = describeCron(cron);
	const invalid = cron.trim() ? cronError(cron) : null;
	const message =
		error ??
		invalid ??
		(words
			? `${words}.${hint ? ` ${hint}` : ""}`
			: "Fields: minute, hour, day of month, month, day of week.");

	return (
		<div className="grid gap-5">
			<div className="grid gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span id={`${id}-label`} className="text-sm font-medium">
						{label}
					</span>
					<Segmented
						label={`${label} editor`}
						value={mode}
						onChange={(m) => {
							setMode(m);
							if (m === "cron")
								requestAnimationFrame(() => input.current?.select());
						}}
						options={[
							{ value: "simple", label: "Simple" },
							{ value: "cron", label: "Cron" },
						]}
					/>
				</div>
				{mode === "simple" ? (
					simple ? (
						<CronBuilder
							id={id}
							value={simple}
							onChange={(s) => onCron(toCron(s))}
						/>
					) : (
						<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-muted/40">
							<p className="text-muted-foreground text-pretty">
								<code className="font-mono text-foreground">{cron}</code> is
								more detailed than the simple editor can show.
							</p>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => onCron(toCron(switchEvery(null, "day")))}
							>
								Replace with daily at 03:00
							</Button>
						</div>
					)
				) : (
					<Input
						ref={input}
						id={id}
						value={cron}
						onChange={(e) => onCron(e.target.value)}
						placeholder="0 3 * * *"
						spellCheck={false}
						autoCapitalize="none"
						autoComplete="off"
						className="font-mono"
						aria-labelledby={`${id}-label`}
						aria-invalid={error || invalid ? true : undefined}
						aria-describedby={`${id}-msg`}
					/>
				)}
				<p
					id={`${id}-msg`}
					aria-live="polite"
					className={cn(
						"flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs",
						error || invalid ? "text-bad-text" : "text-muted-foreground",
					)}
				>
					<span>{message}</span>
					{mode === "simple" && simple && (
						<code className="font-mono text-muted-foreground tabular">
							{cron.trim()}
						</code>
					)}
				</p>
			</div>
			{onTimezone && (
				<Field
					id={`${id}-tz`}
					label="Time zone"
					hint="Runs follow this zone's clock, daylight saving included."
				>
					<TimezonePicker
						id={`${id}-tz`}
						value={timezone}
						onChange={onTimezone}
					/>
				</Field>
			)}
			<NextRuns cron={cron} timezone={timezone} />
		</div>
	);
}

/** Frequency first, then only the controls that frequency needs. */
function CronBuilder({
	id,
	value,
	onChange,
}: {
	id: string;
	value: SimpleCron;
	onChange: (s: SimpleCron) => void;
}) {
	const time = "hour" in value && (
		<BuilderRow label="At" htmlFor={`${id}-time`}>
			<Input
				id={`${id}-time`}
				type="time"
				step={60}
				required
				value={`${pad2(value.hour)}:${pad2(value.minute)}`}
				onChange={(e) => {
					const [h, m] = e.target.value.split(":").map(Number);
					if (Number.isInteger(h) && Number.isInteger(m))
						onChange({ ...value, hour: h as number, minute: m as number });
				}}
				className="w-32 tabular"
			/>
		</BuilderRow>
	);

	return (
		<fieldset
			aria-labelledby={`${id}-label`}
			className="m-0 grid min-w-0 gap-3 rounded-lg border-0 bg-muted/60 p-3 dark:bg-muted/40"
		>
			<BuilderRow label="Repeat">
				<Segmented
					label="Repeat"
					value={value.every}
					onChange={(every) => onChange(switchEvery(value, every))}
					options={EVERY}
				/>
			</BuilderRow>

			{value.every === "minutes" && (
				<BuilderRow label="Every" htmlFor={`${id}-step`}>
					<NumberSelect
						id={`${id}-step`}
						value={value.step}
						options={MINUTE_STEPS}
						format={(n) => (n === 1 ? "minute" : `${n} minutes`)}
						onChange={(n) => onChange({ ...value, step: n })}
					/>
				</BuilderRow>
			)}

			{value.every === "hours" && (
				<>
					<BuilderRow label="Every" htmlFor={`${id}-step`}>
						<NumberSelect
							id={`${id}-step`}
							value={value.step}
							options={HOUR_STEPS}
							format={(n) => (n === 1 ? "hour" : `${n} hours`)}
							onChange={(n) => onChange({ ...value, step: n })}
						/>
					</BuilderRow>
					<BuilderRow label="At minute" htmlFor={`${id}-minute`}>
						<NumberSelect
							id={`${id}-minute`}
							value={value.minute}
							options={MINUTES}
							format={(n) => `:${pad2(n)}`}
							onChange={(n) => onChange({ ...value, minute: n })}
						/>
					</BuilderRow>
				</>
			)}

			{value.every === "week" && (
				<BuilderRow label="On">
					<ToggleGroupPrimitive.Root
						type="multiple"
						aria-label="Days of the week"
						value={value.days.map(String)}
						onValueChange={(days) =>
							days.length && onChange({ ...value, days: days.map(Number) })
						}
						className="flex flex-wrap gap-1"
					>
						{WEEK.map((d) => (
							<ToggleGroupPrimitive.Item
								key={d.value}
								value={String(d.value)}
								aria-label={d.long}
								className={cn(
									"h-8 min-w-11 rounded-md bg-card px-2 text-xs font-medium text-muted-foreground ring-1 ring-border outline-none transition-[color,background-color,box-shadow] duration-(--duration-quick)",
									"hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
									"data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:ring-primary",
								)}
							>
								{d.short}
							</ToggleGroupPrimitive.Item>
						))}
					</ToggleGroupPrimitive.Root>
				</BuilderRow>
			)}

			{value.every === "month" && (
				<BuilderRow
					label="On day"
					htmlFor={`${id}-day`}
					note={
						value.day > 28 ? "Months without this day are skipped." : undefined
					}
				>
					<NumberSelect
						id={`${id}-day`}
						value={value.day}
						options={MONTH_DAYS}
						format={String}
						onChange={(n) => onChange({ ...value, day: n })}
					/>
				</BuilderRow>
			)}

			{time}
		</fieldset>
	);
}

function BuilderRow({
	label,
	htmlFor,
	note,
	children,
}: {
	label: string;
	htmlFor?: string;
	note?: string;
	children: ReactNode;
}) {
	const Label = htmlFor ? "label" : "span";
	return (
		<div className="grid items-center gap-1.5 sm:grid-cols-[6rem_1fr] sm:gap-3">
			<Label
				htmlFor={htmlFor}
				className="text-xs font-medium text-muted-foreground"
			>
				{label}
			</Label>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				{children}
				{note && <span className="text-xs text-muted-foreground">{note}</span>}
			</div>
		</div>
	);
}

function NumberSelect({
	id,
	value,
	options,
	format,
	onChange,
}: {
	id: string;
	value: number;
	options: number[];
	format: (n: number) => string;
	onChange: (n: number) => void;
}) {
	// A hand-written step like */7 still shows instead of a blank select.
	const all = options.includes(value)
		? options
		: [...options, value].sort((a, b) => a - b);
	return (
		<Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
			<SelectTrigger id={id} className="w-36 tabular">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{all.map((n) => (
					<SelectItem key={n} value={String(n)}>
						{format(n)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function NextRuns({
	cron,
	timezone,
	count = 5,
}: {
	cron: string;
	timezone: string;
	count?: number;
}) {
	const runs = useMemo(
		() => nextRuns(cron, timezone, count),
		[cron, timezone, count],
	);
	return (
		<section
			aria-label="Next runs"
			className="rounded-lg bg-muted/60 px-4 py-3 dark:bg-muted/40"
		>
			<h3 className="text-xs font-medium text-muted-foreground [font-stretch:100%]">
				Next {count} runs
			</h3>
			{runs.length ? (
				<ol className="mt-2 grid gap-1.5">
					{runs.map((iso) => (
						<li
							key={iso}
							className="flex items-baseline justify-between gap-4 text-sm"
						>
							<span className="tabular">{formatInZone(iso, timezone)}</span>
							<span className="shrink-0 text-xs text-muted-foreground tabular">
								{relativeTime(iso)}
							</span>
						</li>
					))}
				</ol>
			) : (
				<p className="mt-1.5 text-sm text-muted-foreground">
					Fix the expression to see when it runs.
				</p>
			)}
		</section>
	);
}

export function TimezonePicker({
	id,
	value,
	onChange,
}: {
	id: string;
	value: string;
	onChange: (tz: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const zones = useMemo(timezones, []);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					id={id}
					type="button"
					variant="outline"
					role="combobox"
					aria-expanded={open}
					aria-describedby={`${id}-msg`}
					className="h-8 w-full justify-between font-normal"
				>
					<span className="truncate">{value.replaceAll("_", " ")}</span>
					<ChevronsUpDown className="opacity-50" aria-hidden />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-(--radix-popover-trigger-width) p-0"
				align="start"
			>
				<Command>
					<CommandInput placeholder="Search time zones" />
					<CommandList>
						<CommandEmpty>No time zone matches.</CommandEmpty>
						<CommandGroup>
							{zones.map((z) => (
								<CommandItem
									key={z}
									value={z}
									keywords={[z.replaceAll("_", " ")]}
									data-checked={z === value}
									onSelect={() => {
										onChange(z);
										setOpen(false);
									}}
								>
									<span className="min-w-0 flex-1 truncate">
										{z.replaceAll("_", " ")}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
