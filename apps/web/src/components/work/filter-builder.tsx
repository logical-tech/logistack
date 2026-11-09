/*
 * Filter bar and builder: chips for the active conditions, a "Filter" popover that edits a
 * top-level and/or of conditions and condition groups, with an operator and a value editor per
 * key kind (section 7). Incomplete rows stay in the editor but are left out of the query.
 */
import type { FilterCondition, FilterOp } from "@logistack/contracts";
import { ListFilter, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
import {
	canAddCondition,
	changeOp,
	completeOnly,
	countConditions,
	describeCondition,
	isGroup,
	type KeyDef,
	keyDefs,
	LIST_OPS,
	type Mode,
	type Namer,
	NO_VALUE_OPS,
	newCondition,
	OP_LABEL,
	RELATIVE_LABEL,
	type UiFilter,
	type UiGroup,
} from "./filter-model";
import { PRIORITIES } from "./lib";
import {
	listOptions,
	OptionList,
	type PickerOption,
	peopleOptions,
	priorityOptions,
	statusOptions,
	tagOptions,
} from "./pickers";
import type { WorkProjectContext } from "./views/types";

const CATEGORY_LABEL = {
	backlog: "Backlog",
	active: "Active",
	done: "Done",
	cancelled: "Cancelled",
};

type Ctx = Pick<
	WorkProjectContext,
	"statuses" | "lists" | "fields" | "tags" | "people"
>;

/** The options a value editor offers for a key. */
export function valueOptions(def: KeyDef, ctx: Ctx): PickerOption[] {
	switch (def.value) {
		case "status":
			return statusOptions(ctx.statuses);
		case "statusCategory":
			return Object.entries(CATEGORY_LABEL).map(([id, label]) => ({
				id,
				label,
			}));
		case "people":
			return [
				{ id: "me", label: "Me", hint: "Whoever is viewing" },
				...peopleOptions(ctx.people),
			];
		case "priority":
			return priorityOptions();
		case "list":
			return listOptions(ctx.lists);
		case "tag":
			return tagOptions(ctx.tags);
		case "options": {
			const c = def.field?.config;
			return c && (c.kind === "select" || c.kind === "multi_select")
				? c.options.map((o) => ({ id: o.id, label: o.label }))
				: [];
		}
		default:
			return [];
	}
}

export function useNamer(ctx: Ctx): Namer {
	return useMemo(
		() => (def, id) => {
			if (def.value === "people" && id === "me") return "me";
			if (def.value === "priority")
				return PRIORITIES.find((p) => p.id === id)?.label ?? id;
			if (def.value === "statusCategory")
				return CATEGORY_LABEL[id as keyof typeof CATEGORY_LABEL] ?? id;
			return valueOptions(def, ctx).find((o) => o.id === id)?.label ?? id;
		},
		[ctx],
	);
}

function ValueEditor({
	condition,
	def,
	ctx,
	onChange,
}: {
	condition: FilterCondition;
	def: KeyDef;
	ctx: Ctx;
	onChange: (value: unknown) => void;
}) {
	const { op, value } = condition;
	const namer = useNamer(ctx);
	if (NO_VALUE_OPS.has(op)) return null;
	if (op === "relative")
		return (
			<Select value={String(value)} onValueChange={onChange}>
				<SelectTrigger size="sm" className="min-w-32" aria-label="Date range">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(RELATIVE_LABEL).map(([id, label]) => (
						<SelectItem key={id} value={id}>
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	if (def.value === "bool")
		return (
			<Select
				value={value === false ? "false" : "true"}
				onValueChange={(v) => onChange(v === "true")}
			>
				<SelectTrigger size="sm" aria-label="Value">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="true">Yes</SelectItem>
					<SelectItem value="false">No</SelectItem>
				</SelectContent>
			</Select>
		);
	if (def.value === "date" || def.value === "number" || def.value === "text") {
		const type =
			def.value === "date"
				? "date"
				: def.value === "number"
					? "number"
					: "text";
		const cast = (s: string) => (type === "number" ? Number(s) : s);
		if (op === "between") {
			const [a, b] = Array.isArray(value) ? value : ["", ""];
			return (
				<span className="flex items-center gap-1">
					<Input
						type={type}
						aria-label="From"
						className="h-7 w-32"
						value={String(a ?? "")}
						onChange={(e) => onChange([cast(e.target.value), b])}
					/>
					<span className="text-xs text-muted-foreground">and</span>
					<Input
						type={type}
						aria-label="To"
						className="h-7 w-32"
						value={String(b ?? "")}
						onChange={(e) => onChange([a, cast(e.target.value)])}
					/>
				</span>
			);
		}
		return (
			<Input
				type={type}
				aria-label="Value"
				className="h-7 w-40"
				value={String(value ?? "")}
				placeholder={type === "text" ? "Some text" : undefined}
				onChange={(e) => onChange(cast(e.target.value))}
			/>
		);
	}
	const many = LIST_OPS.has(op);
	const ids = Array.isArray(value)
		? value.map(String)
		: value
			? [String(value)]
			: [];
	return (
		<ValuePicker
			label={
				ids.length
					? ids.map((id) => namer(def, id)).join(", ")
					: many
						? "Choose…"
						: "Choose one…"
			}
			options={valueOptions(def, ctx)}
			ids={ids}
			many={many}
			onChange={(next) => onChange(many ? next : (next[0] ?? ""))}
		/>
	);
}

function ValuePicker({
	label,
	options,
	ids,
	many,
	onChange,
}: {
	label: string;
	options: PickerOption[];
	ids: string[];
	many: boolean;
	onChange: (ids: string[]) => void;
}) {
	const [open, setOpen] = useState(ids.length === 0);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className={cn(
						"max-w-56 justify-start font-normal",
						!ids.length && "text-muted-foreground",
					)}
				>
					<span className="truncate">{label}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-60 p-1">
				<OptionList
					options={options}
					value={ids}
					multiple={many}
					onChange={onChange}
					onDone={() => setOpen(false)}
				/>
			</PopoverContent>
		</Popover>
	);
}

function KeyPicker({
	defs,
	onPick,
	trigger,
}: {
	defs: KeyDef[];
	onPick: (def: KeyDef) => void;
	trigger: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent align="start" className="w-56 p-1">
				<OptionList
					options={defs.map((d) => ({
						id: d.key,
						label: d.label,
						hint: d.field ? "Field" : undefined,
					}))}
					value={[]}
					placeholder="Filter by…"
					onChange={([id]) => {
						const def = defs.find((d) => d.key === id);
						if (def) onPick(def);
					}}
					onDone={() => setOpen(false)}
				/>
			</PopoverContent>
		</Popover>
	);
}

function ModeToggle({
	mode,
	onChange,
	label,
}: {
	mode: Mode;
	onChange: (m: Mode) => void;
	label: string;
}) {
	return (
		<Select value={mode} onValueChange={(v) => onChange(v as Mode)}>
			<SelectTrigger size="sm" className="w-[4.5rem]" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="and">And</SelectItem>
				<SelectItem value="or">Or</SelectItem>
			</SelectContent>
		</Select>
	);
}

function ConditionRow({
	condition,
	defs,
	ctx,
	lead,
	onChange,
	onRemove,
}: {
	condition: FilterCondition;
	defs: KeyDef[];
	ctx: Ctx;
	lead: React.ReactNode;
	onChange: (c: FilterCondition) => void;
	onRemove: () => void;
}) {
	const def = defs.find((d) => d.key === condition.key);
	if (!def) return null;
	return (
		<div className="flex flex-wrap items-center gap-1.5" data-filter-row>
			<span className="w-[4.5rem] shrink-0 text-xs text-muted-foreground">
				{lead}
			</span>
			<Select
				value={condition.key}
				onValueChange={(k) => {
					const next = defs.find((d) => d.key === k);
					if (next) onChange(newCondition(next));
				}}
			>
				<SelectTrigger size="sm" className="min-w-28" aria-label="Field">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{defs.map((d) => (
						<SelectItem key={d.key} value={d.key}>
							{d.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select
				value={condition.op}
				onValueChange={(op) =>
					onChange(changeOp(condition, def, op as FilterOp))
				}
			>
				<SelectTrigger size="sm" aria-label="Operator">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{def.ops.map((op) => (
						<SelectItem key={op} value={op}>
							{OP_LABEL[op]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<ValueEditor
				condition={condition}
				def={def}
				ctx={ctx}
				onChange={(value) => onChange({ ...condition, value })}
			/>
			<Button
				variant="ghost"
				size="icon-sm"
				className="ml-auto text-muted-foreground"
				aria-label="Remove condition"
				onClick={onRemove}
			>
				<X />
			</Button>
		</div>
	);
}

/** The editor itself (also rendered by the "+ View" wizard's starting-filter step). */
export function FilterBuilder({
	value,
	onChange,
	ctx,
}: {
	value: UiFilter;
	onChange: (v: UiFilter) => void;
	ctx: Ctx;
}) {
	const defs = useMemo(() => keyDefs(ctx.fields), [ctx.fields]);
	const room = canAddCondition(value);
	const setItem = (i: number, item: FilterCondition | UiGroup | null) =>
		onChange({
			...value,
			items: item
				? value.items.map((x, j) => (j === i ? item : x))
				: value.items.filter((_, j) => j !== i),
		});
	const lead = (
		i: number,
		mode: Mode,
		set: (m: Mode) => void,
		label: string,
	) =>
		i === 0 ? (
			"Where"
		) : i === 1 ? (
			<ModeToggle mode={mode} onChange={set} label={label} />
		) : mode === "and" ? (
			"And"
		) : (
			"Or"
		);
	const setMode = (mode: Mode) => onChange({ ...value, mode });

	return (
		<div className="grid gap-2">
			{value.items.length === 0 && (
				<p className="px-1 py-2 text-sm text-muted-foreground">
					No filters. Every task in this view is shown.
				</p>
			)}
			{value.items.map((item, i) =>
				isGroup(item) ? (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own.
						key={i}
						className="flex gap-1.5"
					>
						<span className="w-[4.5rem] shrink-0 pt-1 text-xs text-muted-foreground">
							{lead(i, value.mode, setMode, "Combine conditions with")}
						</span>
						<div className="grid min-w-0 flex-1 gap-2 rounded-lg bg-muted/60 p-2">
							{item.conditions.map((c, j) => (
								<ConditionRow
									// biome-ignore lint/suspicious/noArrayIndexKey: as above.
									key={j}
									condition={c}
									defs={defs}
									ctx={ctx}
									lead={lead(
										j,
										item.mode,
										(mode) => setItem(i, { ...item, mode }),
										"Combine group conditions with",
									)}
									onChange={(next) =>
										setItem(i, {
											...item,
											conditions: item.conditions.map((x, k) =>
												k === j ? next : x,
											),
										})
									}
									onRemove={() =>
										setItem(
											i,
											item.conditions.length > 1
												? {
														...item,
														conditions: item.conditions.filter(
															(_, k) => k !== j,
														),
													}
												: null,
										)
									}
								/>
							))}
							<div className="flex items-center gap-1">
								<KeyPicker
									defs={defs}
									onPick={(d) =>
										setItem(i, {
											...item,
											conditions: [...item.conditions, newCondition(d)],
										})
									}
									trigger={
										<Button
											variant="ghost"
											size="xs"
											disabled={!room}
											className="text-muted-foreground"
										>
											<Plus data-icon="inline-start" /> Add to group
										</Button>
									}
								/>
								<Button
									variant="ghost"
									size="xs"
									className="ml-auto text-muted-foreground"
									onClick={() => setItem(i, null)}
								>
									<Trash2 data-icon="inline-start" /> Remove group
								</Button>
							</div>
						</div>
					</div>
				) : (
					<ConditionRow
						// biome-ignore lint/suspicious/noArrayIndexKey: as above.
						key={i}
						condition={item}
						defs={defs}
						ctx={ctx}
						lead={lead(i, value.mode, setMode, "Combine conditions with")}
						onChange={(c) => setItem(i, c)}
						onRemove={() => setItem(i, null)}
					/>
				),
			)}
			<div className="flex items-center gap-1 pt-1">
				<KeyPicker
					defs={defs}
					onPick={(d) =>
						onChange({ ...value, items: [...value.items, newCondition(d)] })
					}
					trigger={
						<Button variant="ghost" size="sm" disabled={!room}>
							<Plus data-icon="inline-start" /> Add condition
						</Button>
					}
				/>
				<KeyPicker
					defs={defs}
					onPick={(d) =>
						onChange({
							...value,
							items: [
								...value.items,
								{ mode: "or", conditions: [newCondition(d)] },
							],
						})
					}
					trigger={
						<Button
							variant="ghost"
							size="sm"
							disabled={!room}
							className="text-muted-foreground"
						>
							<Plus data-icon="inline-start" /> Add group
						</Button>
					}
				/>
				{!room && (
					<span className="text-xs text-muted-foreground">
						30 conditions at most
					</span>
				)}
				{value.items.length > 0 && (
					<Button
						variant="ghost"
						size="sm"
						className="ml-auto text-muted-foreground"
						onClick={() => onChange({ mode: "and", items: [] })}
					>
						Clear all
					</Button>
				)}
			</div>
		</div>
	);
}

/** Chips for the complete conditions plus the Filter button with the builder. */
export function FilterBar({
	value,
	onChange,
	ctx,
}: {
	value: UiFilter;
	onChange: (v: UiFilter) => void;
	ctx: Ctx;
}) {
	const defs = useMemo(() => keyDefs(ctx.fields), [ctx.fields]);
	const namer = useNamer(ctx);
	const complete = completeOnly(value);
	const count = countConditions(complete);
	const chips = complete.items.map((item) =>
		isGroup(item)
			? `(${item.conditions
					.map((c) =>
						describeCondition(
							c,
							defs.find((d) => d.key === c.key),
							namer,
						),
					)
					.join(item.mode === "and" ? " and " : " or ")})`
			: describeCondition(
					item,
					defs.find((d) => d.key === item.key),
					namer,
				),
	);
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-1.5">
			<Popover>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className={cn(count > 0 && "border-brand/40 bg-brand/5")}
					>
						<ListFilter data-icon="inline-start" />
						Filter
						{count > 0 && (
							<span className="ml-0.5 rounded-sm bg-brand/15 px-1 text-2xs text-brand tabular">
								{count}
							</span>
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className="w-[min(40rem,calc(100vw-2rem))] p-3"
				>
					<FilterBuilder value={value} onChange={onChange} ctx={ctx} />
				</PopoverContent>
			</Popover>
			{chips.map((text, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: positional chips.
					key={i}
					className="inline-flex h-7 max-w-80 items-center gap-1 rounded-md bg-muted pr-0.5 pl-2 text-xs"
				>
					<span className="truncate">{text}</span>
					<button
						type="button"
						aria-label={`Remove filter: ${text}`}
						onClick={() =>
							onChange({
								...complete,
								items: complete.items.filter((_, j) => j !== i),
							})
						}
						className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
					>
						<X className="size-3" />
					</button>
				</span>
			))}
			{count > 1 && complete.mode === "or" && (
				<span className="text-xs text-muted-foreground">Any matches</span>
			)}
		</div>
	);
}
