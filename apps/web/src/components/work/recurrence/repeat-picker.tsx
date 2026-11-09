import type { RecurrenceRule } from "@logistack/contracts";
import { describeRule, weekdayOf } from "@logistack/core/work";
import { Check, Repeat } from "lucide-react";
import { useId, useState } from "react";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

const COPY_ALL: RecurrenceRule["copy"] = {
	subtasks: true,
	checklist: true,
	fields: true,
	assignees: true,
	description: true,
};
const base = (r: Partial<RecurrenceRule>): RecurrenceRule => ({
	freq: "weekly",
	interval: 1,
	mode: "on_complete",
	ends: { kind: "never" },
	copy: COPY_ALL,
	...r,
});
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ordinal = (n: number) =>
	`${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** Task sheet "Repeat" row: presets plus a full form; `null` means "Doesn't repeat". */
export function RepeatPicker({
	value,
	onChange,
	dueDate,
	disabled,
}: {
	value: RecurrenceRule | null;
	onChange: (rule: RecurrenceRule | null) => void;
	/** Anchors the weekday and day-of-month presets; today when absent. */
	dueDate?: string | null;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [custom, setCustom] = useState(false);
	const anchor = dueDate ?? new Date().toISOString().slice(0, 10);
	const wd = weekdayOf(anchor);
	const dom = Number(anchor.slice(8, 10));
	const presets: { label: string; rule: RecurrenceRule }[] = [
		{ label: "Every day", rule: base({ freq: "daily" }) },
		{
			label: "Every weekday",
			rule: base({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5] }),
		},
		{
			label: `Every week on ${DAYS[wd]}`,
			rule: base({ freq: "weekly", byWeekday: [wd] }),
		},
		{
			label: `Every month on the ${ordinal(dom)}`,
			rule: base({
				freq: "monthly",
				monthly: { kind: "dayOfMonth", day: dom },
			}),
		},
	];
	const pick = (rule: RecurrenceRule | null) => {
		onChange(rule);
		setOpen(false);
	};
	const same = (a: RecurrenceRule) =>
		value &&
		a.freq === value.freq &&
		a.interval === value.interval &&
		JSON.stringify(a.byWeekday) === JSON.stringify(value.byWeekday) &&
		JSON.stringify(a.monthly) === JSON.stringify(value.monthly);

	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (!o) setCustom(false);
			}}
		>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={disabled}
					className={cn("justify-start", !value && "text-muted-foreground")}
				>
					<Repeat data-icon="inline-start" />
					{value ? describeRule(value) : "Doesn't repeat"}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={cn("p-1", custom ? "w-80" : "w-64")}
			>
				{custom ? (
					<CustomForm
						initial={value ?? presets[2]?.rule ?? base({})}
						onCancel={() => setCustom(false)}
						onSave={pick}
					/>
				) : (
					<div role="menu" className="grid">
						{presets.map((p) => (
							<MenuRow
								key={p.label}
								checked={!!same(p.rule)}
								onClick={() =>
									pick({ ...p.rule, mode: value?.mode ?? p.rule.mode })
								}
							>
								{p.label}
							</MenuRow>
						))}
						<MenuRow onClick={() => setCustom(true)}>Custom…</MenuRow>
						{value && (
							<>
								<div className="my-1 h-px bg-border" />
								<MenuRow onClick={() => pick(null)}>Stop repeating</MenuRow>
							</>
						)}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

function MenuRow({
	children,
	checked,
	onClick,
}: {
	children: string;
	checked?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={checked ?? false}
			onClick={onClick}
			className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
		>
			<Check
				className={cn("size-3.5", checked ? "opacity-100" : "opacity-0")}
				aria-hidden
			/>
			{children}
		</button>
	);
}

function CustomForm({
	initial,
	onSave,
	onCancel,
}: {
	initial: RecurrenceRule;
	onSave: (r: RecurrenceRule) => void;
	onCancel: () => void;
}) {
	const id = useId();
	const [r, setR] = useState<RecurrenceRule>(initial);
	const set = (patch: Partial<RecurrenceRule>) =>
		setR((x) => ({ ...x, ...patch }));
	const days = r.byWeekday ?? [];
	const valid =
		r.interval >= 1 &&
		r.interval <= 365 &&
		(r.freq !== "weekly" || days.length > 0) &&
		(r.ends.kind !== "on" || /^\d{4}-\d{2}-\d{2}$/.test(r.ends.date));

	return (
		<form
			className="grid gap-3 p-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (valid)
					onSave({
						...r,
						byWeekday: r.freq === "weekly" ? days : undefined,
						monthly: r.freq === "monthly" ? r.monthly : undefined,
						remaining: undefined,
					});
			}}
		>
			<div className="flex items-end gap-2">
				<Field id={`${id}-i`} label="Every" className="w-20">
					<Input
						id={`${id}-i`}
						type="number"
						min={1}
						max={365}
						className="h-8 text-sm"
						value={r.interval}
						onChange={(e) => set({ interval: Number(e.target.value) || 1 })}
					/>
				</Field>
				<Select
					value={r.freq}
					onValueChange={(v) => set({ freq: v as RecurrenceRule["freq"] })}
				>
					<SelectTrigger aria-label="Unit" className="flex-1">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="daily">day(s)</SelectItem>
						<SelectItem value="weekly">week(s)</SelectItem>
						<SelectItem value="monthly">month(s)</SelectItem>
						<SelectItem value="yearly">year(s)</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{r.freq === "weekly" && (
				<fieldset className="grid gap-2">
					<legend className="mb-2 text-sm font-medium">On</legend>
					<div className="flex gap-1">
						{DAYS.map((d, i) => {
							const on = days.includes(i);
							return (
								<button
									key={d}
									type="button"
									aria-pressed={on}
									onClick={() =>
										set({
											byWeekday: on
												? days.filter((x) => x !== i)
												: [...days, i],
										})
									}
									className={cn(
										"h-8 flex-1 rounded-md text-xs font-medium ring-1 ring-border outline-none transition-colors duration-(--duration-quick) focus-visible:ring-2 focus-visible:ring-ring",
										on
											? "bg-foreground text-background ring-foreground"
											: "hover:bg-muted",
									)}
								>
									{d.slice(0, 2)}
								</button>
							);
						})}
					</div>
				</fieldset>
			)}

			{r.freq === "monthly" && (
				<Field id={`${id}-m`} label="On day">
					<Select
						value={String(r.monthly?.kind === "dayOfMonth" ? r.monthly.day : 1)}
						onValueChange={(v) =>
							set({ monthly: { kind: "dayOfMonth", day: Number(v) } })
						}
					>
						<SelectTrigger id={`${id}-m`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{MONTH_DAYS.map((d) => (
								<SelectItem key={d} value={String(d)}>
									{ordinal(d)}
								</SelectItem>
							))}
							<SelectItem value="-1">Last day</SelectItem>
						</SelectContent>
					</Select>
				</Field>
			)}

			<div className="grid gap-2">
				<span className="text-sm font-medium">Create the next one</span>
				<Segmented
					label="When to create the next occurrence"
					value={r.mode}
					onChange={(mode) => set({ mode })}
					options={[
						{ value: "on_complete", label: "When done" },
						{ value: "on_schedule", label: "On schedule" },
					]}
				/>
			</div>

			<div className="grid gap-2">
				<span className="text-sm font-medium">Ends</span>
				<Segmented
					label="Ends"
					value={r.ends.kind}
					onChange={(kind) =>
						set({
							ends:
								kind === "never"
									? { kind }
									: kind === "on"
										? { kind, date: "" }
										: { kind, count: 10 },
						})
					}
					options={[
						{ value: "never", label: "Never" },
						{ value: "on", label: "On date" },
						{ value: "after", label: "After" },
					]}
				/>
				{r.ends.kind === "on" && (
					<Input
						type="date"
						aria-label="End date"
						value={r.ends.date}
						onChange={(e) =>
							set({ ends: { kind: "on", date: e.target.value } })
						}
					/>
				)}
				{r.ends.kind === "after" && (
					<Input
						type="number"
						aria-label="Number of occurrences"
						min={1}
						max={1000}
						value={r.ends.count}
						onChange={(e) =>
							set({
								ends: {
									kind: "after",
									count: Math.min(
										1000,
										Math.max(1, Number(e.target.value) || 1),
									),
								},
							})
						}
					/>
				)}
			</div>

			<label htmlFor={`${id}-w`} className="flex items-center gap-2 text-sm">
				<Checkbox
					id={`${id}-w`}
					checked={r.skipWeekends ?? false}
					onCheckedChange={(v) => set({ skipWeekends: v === true })}
				/>
				Move off weekends
			</label>

			<p className="text-xs text-muted-foreground" aria-live="polite">
				{valid ? describeRule(r) : "Pick at least one day"}
			</p>
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Back
				</Button>
				<Button type="submit" size="sm" disabled={!valid}>
					Save
				</Button>
			</div>
		</form>
	);
}
