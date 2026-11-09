/*
 * One editor and one display per custom-field kind (all 14), shared by the task sheet's
 * properties grid and the table's cells. The editor commits a parsed value (or null to clear)
 * and never writes something `parseFieldValue` would refuse.
 */
import type { WorkField, WorkPerson } from "@logistack/contracts";
import { formatFieldValue } from "@logistack/core/work";
import { Check, ExternalLink, Flame, Heart, Star } from "lucide-react";
import { useId, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { commitFieldText, fieldText, TEXT_KINDS } from "./field-input";
import { AvatarStack, ColorChip } from "./parts";
import { OptionList, peopleOptions } from "./pickers";

const RATING_ICON = { star: Star, flame: Flame, heart: Heart } as const;

const asList = (v: unknown): string[] =>
	Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];

export function FieldDisplay({
	field,
	value,
	people,
	className,
}: {
	field: WorkField;
	value: unknown;
	people: WorkPerson[];
	className?: string;
}) {
	const c = field.config;
	const empty =
		value === null ||
		value === undefined ||
		value === "" ||
		(Array.isArray(value) && value.length === 0);
	if (empty)
		return <span className={cn("text-muted-foreground/70", className)}>–</span>;
	switch (c.kind) {
		case "checkbox":
			return (
				<span
					role="img"
					aria-label={value ? "Yes" : "No"}
					className={cn(
						"grid size-4 place-items-center rounded-[4px]",
						value ? "bg-primary text-primary-foreground" : "ring-1 ring-input",
						className,
					)}
				>
					{value === true && <Check className="size-3" strokeWidth={3} />}
				</span>
			);
		case "select":
		case "multi_select": {
			const ids = asList(value);
			const opts = c.options.filter((o) => ids.includes(o.id));
			return (
				<span className={cn("flex min-w-0 flex-wrap gap-1", className)}>
					{opts.map((o) => (
						<ColorChip key={o.id} color={o.color}>
							{o.label}
						</ColorChip>
					))}
				</span>
			);
		}
		case "user":
			return (
				<span className={cn("flex items-center gap-1.5", className)}>
					<AvatarStack people={people} ids={asList(value)} />
					{asList(value).length === 1 && (
						<span className="truncate text-sm">
							{people.find((p) => p.userId === asList(value)[0])?.name ??
								"Former member"}
						</span>
					)}
				</span>
			);
		case "rating": {
			const Icon = RATING_ICON[c.icon];
			const n = Number(value);
			return (
				<span
					role="img"
					aria-label={`${n} of ${c.max}`}
					className={cn("flex items-center gap-0.5", className)}
				>
					{Array.from({ length: c.max }, (_, i) => (
						<Icon
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed positions.
							key={i}
							aria-hidden
							className={cn(
								"size-3.5",
								i < n ? "fill-busy text-busy" : "text-muted-foreground/30",
							)}
						/>
					))}
				</span>
			);
		}
		case "url":
			return (
				<a
					href={String(value)}
					target="_blank"
					rel="noreferrer noopener"
					onClick={(e) => e.stopPropagation()}
					className={cn(
						"inline-flex min-w-0 items-center gap-1 text-sm text-info-text hover:underline",
						className,
					)}
				>
					<span className="truncate">
						{String(value).replace(/^https?:\/\//, "")}
					</span>
					<ExternalLink className="size-3 shrink-0" aria-hidden />
				</a>
			);
		case "email":
			return (
				<a
					href={`mailto:${String(value)}`}
					onClick={(e) => e.stopPropagation()}
					className={cn(
						"truncate text-sm text-info-text hover:underline",
						className,
					)}
				>
					{String(value)}
				</a>
			);
		case "long_text":
			return (
				<span
					className={cn("line-clamp-2 text-sm whitespace-pre-line", className)}
				>
					{String(value)}
				</span>
			);
		default:
			return (
				<span
					className={cn(
						"truncate text-sm",
						(c.kind === "number" ||
							c.kind === "currency" ||
							c.kind === "percent") &&
							"tabular",
						className,
					)}
				>
					{formatFieldValue(
						field,
						value,
						undefined,
						Object.fromEntries(people.map((p) => [p.userId, p.name])),
					)}
				</span>
			);
	}
}

/**
 * The editing surface for a field, sized for a popover or a table cell. `onCommit` receives the
 * parsed value (null clears); `onCancel` is Esc. List kinds commit on every pick.
 */
export function FieldEditor({
	field,
	value,
	people,
	onCommit,
	onCancel,
	autoFocus = true,
	me,
}: {
	field: WorkField;
	value: unknown;
	people: WorkPerson[];
	onCommit: (value: unknown) => void;
	onCancel?: () => void;
	autoFocus?: boolean;
	me?: string;
}) {
	const c = field.config;
	const id = useId();
	const [text, setText] = useState(() => fieldText(field, value));
	const [error, setError] = useState<string | null>(null);

	if (TEXT_KINDS.has(c.kind)) {
		const commit = () => {
			const r = commitFieldText(field, text);
			if (!r.ok) {
				setError(r.error);
				return;
			}
			setError(null);
			onCommit(r.value);
		};
		const onKeyDown = (e: React.KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onCancel?.();
			}
			if (
				e.key === "Enter" &&
				(c.kind !== "long_text" || e.metaKey || e.ctrlKey)
			) {
				e.preventDefault();
				commit();
			}
		};
		const common = {
			id,
			value: text,
			autoFocus,
			"aria-label": field.name,
			"aria-invalid": error ? true : undefined,
			"aria-describedby": error ? `${id}-err` : undefined,
			onKeyDown,
			onBlur: commit,
		};
		return (
			<div className="grid gap-1">
				{c.kind === "long_text" ? (
					<Textarea
						{...common}
						rows={4}
						onChange={(e) => setText(e.target.value)}
					/>
				) : (
					<Input
						{...common}
						type={c.kind === "email" ? "email" : "text"}
						inputMode={
							c.kind === "number" ||
							c.kind === "currency" ||
							c.kind === "percent"
								? "decimal"
								: c.kind === "phone"
									? "tel"
									: c.kind === "url"
										? "url"
										: undefined
						}
						placeholder={PLACEHOLDER[c.kind]}
						onChange={(e) => setText(e.target.value)}
					/>
				)}
				{error && (
					<p id={`${id}-err`} role="alert" className="text-xs text-bad-text">
						{error}
					</p>
				)}
			</div>
		);
	}

	switch (c.kind) {
		case "checkbox":
			return (
				<div className="flex items-center gap-2 text-sm">
					<Checkbox
						id={id}
						autoFocus={autoFocus}
						checked={value === true}
						onCheckedChange={(v) => onCommit(v === true ? true : null)}
					/>
					<label htmlFor={id}>{field.name}</label>
				</div>
			);
		case "select":
		case "multi_select":
			return (
				<OptionList
					options={c.options.map((o) => ({
						id: o.id,
						label: o.label,
						icon: (
							<span
								aria-hidden
								style={{ background: `var(--wc-${o.color})` }}
								className="size-2 rounded-full"
							/>
						),
					}))}
					value={asList(value)}
					multiple={c.kind === "multi_select"}
					clearable
					onChange={(ids) =>
						onCommit(c.kind === "multi_select" ? ids : (ids[0] ?? null))
					}
					placeholder={`${field.name}…`}
				/>
			);
		case "user":
			return (
				<OptionList
					options={peopleOptions(people, { me })}
					value={asList(value)}
					multiple={c.multiple}
					clearable
					onChange={(ids) => onCommit(c.multiple ? ids : (ids[0] ?? null))}
					placeholder="Find a person…"
				/>
			);
		case "rating": {
			const Icon = RATING_ICON[c.icon];
			const n = Number(value ?? 0);
			return (
				<div
					role="radiogroup"
					aria-label={field.name}
					className="flex items-center gap-0.5"
				>
					{Array.from({ length: c.max }, (_, i) => (
						// biome-ignore lint/a11y/useSemanticElements: icon radios, a native radio can't draw them.
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed positions.
							key={i}
							type="button"
							role="radio"
							aria-checked={n === i + 1}
							aria-label={`${i + 1} of ${c.max}`}
							// biome-ignore lint/a11y/noAutofocus: the editor opens on purpose, focus goes to it.
							autoFocus={autoFocus && i === Math.max(0, n - 1)}
							onClick={() => onCommit(n === i + 1 ? null : i + 1)}
							className="grid size-7 place-items-center rounded-md hover:bg-muted"
						>
							<Icon
								aria-hidden
								className={cn(
									"size-4",
									i < n ? "fill-busy text-busy" : "text-muted-foreground/40",
								)}
							/>
						</button>
					))}
				</div>
			);
		}
	}
	return null;
}

const PLACEHOLDER: Partial<Record<WorkField["kind"], string>> = {
	number: "0",
	currency: "1234.50",
	percent: "50",
	date: "fri, 12 dec, 2026-12-03",
	url: "example.com",
	email: "name@example.com",
	phone: "+39 02 1234 5678",
};
