import type { LsdcInstance, LsdcLimits } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Field } from "@/components/field";
import { UsageMeter } from "@/components/monitoring/node-parts";
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
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { lsdcApi, lsdcUsageQuery, useLsdcMutation } from "@/lib/api/lsdc";
import { formatBytes, pct } from "@/lib/metrics";

export const CURRENCIES = ["EUR", "USD", "GBP", "CHF"];

export const money = (cents: number, currency: string) =>
	new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
		cents / 100,
	);

export const cores = (n: number) =>
	`${Number(n.toFixed(2))} ${n === 1 ? "core" : "cores"}`;

/** LSDC counts in MB; shown in binary units like the rest of the app. */
export const megabytes = (mb: number) => formatBytes(mb * 1024 ** 2, true);

/** "149", "149.90" or "149,90" in major units → cents; "" → null; undefined when invalid. */
export function parsePrice(raw: string): number | null | undefined {
	const s = raw.trim().replace(",", ".");
	if (!s) return null;
	if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
	return Math.round(Number(s) * 100);
}

export const priceInput = (cents: number | null) =>
	cents === null ? "" : (cents / 100).toFixed(2);

/** Text fields of the three limits, checked against the contract's bounds. */
export function parseLimits(v: {
	cpu: string;
	ramMb: string;
	storageMb: string;
}): { limits?: LsdcLimits; errors: Record<string, string> } {
	const errors: Record<string, string> = {};
	const cpu = Number(v.cpu.replace(",", "."));
	const ramMb = Number(v.ramMb);
	const storageMb = Number(v.storageMb);
	if (!(cpu >= 0.1 && cpu <= 64)) errors.cpu = "Between 0.1 and 64 cores.";
	if (!(Number.isInteger(ramMb) && ramMb >= 128 && ramMb <= 262_144))
		errors.ramMb = "Whole megabytes, 128 to 262144.";
	if (
		!(Number.isInteger(storageMb) && storageMb >= 64 && storageMb <= 10_000_000)
	)
		errors.storageMb = "Whole megabytes, at least 64.";
	return Object.keys(errors).length
		? { errors }
		: { limits: { cpu, ramMb, storageMb }, errors };
}

/** CPU, RAM and disk against the plan's limits, read live from the instance. */
export function UsageCell({ instance }: { instance: LsdcInstance }) {
	const { data, isPending, isError, error } = useQuery(
		lsdcUsageQuery(instance.id),
	);
	if (isPending)
		return (
			<div className="grid grid-cols-3 gap-3">
				<span className="sr-only">Loading usage</span>
				{[0, 1, 2].map((i) => (
					<div key={i} className="grid gap-1.5" aria-hidden>
						<span className="t-skel h-2.5 w-10 rounded bg-muted-foreground/15" />
						<span className="t-skel h-1 rounded-full bg-muted-foreground/12" />
					</div>
				))}
			</div>
		);
	const reason = isError ? error.message : data.reachable ? null : data.reason;
	if (reason !== null || !data?.reachable) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className="inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span aria-hidden className="size-1.5 rounded-full bg-idle" />
						Unreachable
						<span className="sr-only">: {reason}</span>
					</button>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs break-words">
					{reason}
				</TooltipContent>
			</Tooltip>
		);
	}
	const l = instance.limits;
	const of = (used: string, limit: string | null) =>
		limit ? `${used} / ${limit}` : `${used} · no limit`;
	return (
		<div className="grid grid-cols-3 gap-3 t-reveal">
			<UsageMeter
				label="CPU"
				value={pct(data.cpu, l.cpu)}
				reading={of(
					data.cpu === null ? "–" : String(Number(data.cpu.toFixed(2))),
					l.cpu === null ? null : String(l.cpu),
				)}
				detail={`CPU ${data.cpu === null ? "unknown" : cores(data.cpu)} of ${l.cpu === null ? "no limit" : cores(l.cpu)}`}
			/>
			<UsageMeter
				label="RAM"
				value={pct(data.ramMb, l.ramMb)}
				reading={of(
					data.ramMb === null ? "–" : megabytes(data.ramMb),
					l.ramMb === null ? null : megabytes(l.ramMb),
				)}
				detail={`RAM ${data.ramMb === null ? "unknown" : megabytes(data.ramMb)} of ${l.ramMb === null ? "no limit" : megabytes(l.ramMb)}`}
			/>
			<UsageMeter
				label="Disk"
				value={pct(data.storageMb, l.storageMb)}
				reading={of(
					megabytes(data.storageMb),
					l.storageMb === null ? null : megabytes(l.storageMb),
				)}
				detail={`Disk ${megabytes(data.storageMb)} of ${l.storageMb === null ? "no limit" : megabytes(l.storageMb)}`}
			/>
		</div>
	);
}

export function CurrencySelect({
	id,
	value,
	onChange,
}: {
	id: string;
	value: string;
	onChange: (v: string) => void;
}) {
	const list = CURRENCIES.includes(value) ? CURRENCIES : [value, ...CURRENCIES];
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger id={id} className="w-24" aria-label="Currency">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{list.map((c) => (
					<SelectItem key={c} value={c}>
						{c}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** The three limits as number fields with their units. */
export function LimitFields({
	id,
	values,
	errors,
	onChange,
}: {
	id: string;
	values: { cpu: string; ramMb: string; storageMb: string };
	errors: Record<string, string | undefined>;
	onChange: (key: "cpu" | "ramMb" | "storageMb", value: string) => void;
}) {
	const fields = [
		{ key: "cpu", label: "CPU", unit: "cores", step: "0.1" },
		{ key: "ramMb", label: "RAM", unit: "MB", step: "128" },
		{ key: "storageMb", label: "Storage", unit: "MB", step: "1024" },
	] as const;
	return (
		<div className="grid gap-4 sm:grid-cols-3">
			{fields.map((f) => (
				<Field
					key={f.key}
					id={`${id}-${f.key}`}
					label={`${f.label} (${f.unit})`}
					error={errors[f.key]}
					hint={
						f.key !== "cpu" && Number(values[f.key]) > 0
							? megabytes(Number(values[f.key]))
							: undefined
					}
				>
					<Input
						id={`${id}-${f.key}`}
						name={f.key}
						type="number"
						inputMode="decimal"
						min={0}
						step={f.step}
						value={values[f.key]}
						onChange={(e) => onChange(f.key, e.target.value)}
						className="tabular"
						aria-invalid={errors[f.key] ? true : undefined}
						aria-describedby={`${id}-${f.key}-msg`}
					/>
				</Field>
			))}
		</div>
	);
}

const limitsText = (l: LsdcInstance["limits"]) => ({
	cpu: l.cpu === null ? "" : String(l.cpu),
	ramMb: l.ramMb === null ? "" : String(l.ramMb),
	storageMb: l.storageMb === null ? "" : String(l.storageMb),
});

/** Customer, price and limits of one instance; only changed fields are sent, so a price edit never redeploys. */
export function EditInstanceDialog({
	instance,
	onOpenChange,
}: {
	instance: LsdcInstance | null;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={instance !== null} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				{instance && (
					<EditForm
						key={instance.id}
						instance={instance}
						onDone={() => onOpenChange(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function EditForm({
	instance,
	onDone,
}: {
	instance: LsdcInstance;
	onDone: () => void;
}) {
	const uid = useId();
	const update = useLsdcMutation(
		(input: Parameters<typeof lsdcApi.update>[1]) =>
			lsdcApi.update(instance.id, input),
	);
	const initialLimits = limitsText(instance.limits);
	const [customer, setCustomer] = useState(instance.customer ?? "");
	const [price, setPrice] = useState(priceInput(instance.priceCents));
	const [currency, setCurrency] = useState(instance.currency);
	const [limits, setLimits] = useState(initialLimits);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const limitsChanged =
		JSON.stringify(limits) !== JSON.stringify(initialLimits);

	async function submit(e: FormEvent) {
		e.preventDefault();
		const next: Record<string, string> = {};
		const name = customer.trim();
		if (!name) next.customer = "Enter the customer's name.";
		const cents = parsePrice(price);
		if (cents === undefined) next.price = "A price like 149 or 149.90.";
		const parsed = limitsChanged ? parseLimits(limits) : undefined;
		Object.assign(next, parsed?.errors);
		setErrors(next);
		if (Object.keys(next).length || cents === undefined) return;
		try {
			await update.mutateAsync({
				...(name !== instance.customer && { customer: name }),
				...(cents !== instance.priceCents && { priceCents: cents }),
				...(currency !== instance.currency && { currency }),
				...(parsed?.limits && { limits: parsed.limits }),
			});
			onDone();
		} catch (err) {
			setErrors({ form: err instanceof Error ? err.message : String(err) });
		}
	}

	return (
		<form onSubmit={submit} noValidate className="grid gap-5">
			<DialogHeader>
				<DialogTitle>Edit {instance.customer ?? instance.name}</DialogTitle>
				<DialogDescription>
					The customer and price are LogiStack's own records. New limits apply
					to the container and to LSDC's storage quota.
				</DialogDescription>
			</DialogHeader>

			<Field id={`${uid}-customer`} label="Customer" error={errors.customer}>
				<Input
					id={`${uid}-customer`}
					value={customer}
					onChange={(e) => setCustomer(e.target.value)}
					maxLength={100}
					autoComplete="organization"
					aria-invalid={errors.customer ? true : undefined}
					aria-describedby={`${uid}-customer-msg`}
				/>
			</Field>

			<Field
				id={`${uid}-price`}
				label="Monthly price"
				error={errors.price}
				hint="Leave empty for no price."
			>
				<div className="flex gap-2">
					<Input
						id={`${uid}-price`}
						value={price}
						onChange={(e) => setPrice(e.target.value)}
						inputMode="decimal"
						placeholder="0.00"
						className="tabular max-w-40"
						aria-invalid={errors.price ? true : undefined}
						aria-describedby={`${uid}-price-msg`}
					/>
					<CurrencySelect
						id={`${uid}-currency`}
						value={currency}
						onChange={setCurrency}
					/>
				</div>
			</Field>

			<fieldset className="grid gap-3">
				<legend className="mb-3 text-sm font-medium">Limits</legend>
				<LimitFields
					id={uid}
					values={limits}
					errors={errors}
					onChange={(k, v) => setLimits((l) => ({ ...l, [k]: v }))}
				/>
				{limitsChanged && (
					<p className="t-reveal flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2.5 text-sm text-warn-text">
						<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
						Saving redeploys the instance. It restarts with the new limits,
						usually within a minute.
					</p>
				)}
			</fieldset>

			{errors.form && (
				<p className="text-sm text-bad-text" role="alert">
					{errors.form}
				</p>
			)}

			<DialogFooter>
				<Button type="button" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				<Button type="submit" disabled={update.isPending}>
					{limitsChanged ? "Save and redeploy" : "Save changes"}
				</Button>
			</DialogFooter>
		</form>
	);
}
