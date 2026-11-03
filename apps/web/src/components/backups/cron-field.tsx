import { ChevronsUpDown } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
	CRON_PRESETS,
	cronError,
	describeCron,
	formatInZone,
	nextRuns,
	timezones,
} from "@/lib/cron";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A cron expression with presets, its meaning in words, and (optionally) its time zone. */
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
	const preset = CRON_PRESETS.find((p) => p.value === cron.trim())?.value;
	const [custom, setCustom] = useState(!preset);
	const words = describeCron(cron);
	const invalid = cron.trim() ? cronError(cron) : null;

	return (
		<div className="grid gap-5">
			<div className="grid gap-2">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<label htmlFor={id} className="text-sm font-medium">
						{label}
					</label>
					<Segmented
						label={`${label} presets`}
						value={custom || !preset ? "custom" : preset}
						onChange={(v) => {
							if (v === "custom") {
								setCustom(true);
								requestAnimationFrame(() => input.current?.select());
								return;
							}
							setCustom(false);
							onCron(v);
						}}
						options={[
							...CRON_PRESETS.map((p) => ({ value: p.value, label: p.label })),
							{ value: "custom", label: "Custom" },
						]}
					/>
				</div>
				<Input
					ref={input}
					id={id}
					value={cron}
					onChange={(e) => {
						setCustom(true);
						onCron(e.target.value);
					}}
					placeholder="0 3 * * *"
					spellCheck={false}
					autoCapitalize="none"
					autoComplete="off"
					className="font-mono"
					aria-invalid={error || invalid ? true : undefined}
					aria-describedby={`${id}-msg`}
				/>
				<p
					id={`${id}-msg`}
					aria-live="polite"
					className={cn(
						"text-xs",
						error || invalid ? "text-bad-text" : "text-muted-foreground",
					)}
				>
					{error ??
						invalid ??
						(words
							? `${words}.${hint ? ` ${hint}` : ""}`
							: "Fields: minute, hour, day of month, month, day of week.")}
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
