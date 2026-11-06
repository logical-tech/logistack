import { X } from "lucide-react";
import type { ReactNode } from "react";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { ServiceThresholdMetric } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export const WINDOWS = [60, 300, 600, 900, 1_800, 3_600];
export const minutes = (s: number) =>
	s < 3_600 ? `${s / 60} min` : `${s / 3_600} h`;

export const SERVICE_METRIC: Record<
	ServiceThresholdMetric,
	{ label: string; unit: string }
> = {
	cpu: { label: "CPU", unit: "% CPU" },
	memoryPercent: { label: "Memory, % of limit", unit: "% of limit" },
	memoryMb: { label: "Memory, MB", unit: "MB" },
};

/** Memory reads against the limit when the service sets one, else in MB. */
export const memoryMetric = (memoryMb: number | undefined) =>
	memoryMb ? ("memoryPercent" as const) : ("memoryMb" as const);

export type ServiceThresholdDraft = {
	metric: ServiceThresholdMetric;
	above: number;
	forSec: number;
	enabled: boolean;
	firing?: boolean | null;
};

const FIRING = { label: "Over limit", tone: "bad" } as const;

/**
 * One editable per-service threshold. `lead` is an optional first column (the service, on
 * the monitoring settings); the row is otherwise the same in both places.
 */
export function ServiceThresholdRow({
	value: t,
	onChange,
	onRemove,
	error,
	lead,
}: {
	value: ServiceThresholdDraft;
	onChange: (patch: Partial<ServiceThresholdDraft>) => void;
	onRemove: () => void;
	error?: string | undefined;
	lead?: ReactNode;
}) {
	const meta = SERVICE_METRIC[t.metric];
	return (
		<li
			className={cn(
				"grid gap-3 px-4 py-3.5 sm:items-center",
				lead
					? "sm:grid-cols-[minmax(0,1fr)_11rem_9rem_7rem_auto]"
					: "sm:grid-cols-[11rem_9rem_7rem_minmax(0,1fr)_auto]",
				!t.enabled && "[&_.dim]:opacity-55",
			)}
		>
			{lead}
			<Select
				value={t.metric}
				onValueChange={(v) => onChange({ metric: v as ServiceThresholdMetric })}
			>
				<SelectTrigger className="dim w-full" aria-label="Metric">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{(Object.keys(SERVICE_METRIC) as ServiceThresholdMetric[]).map(
						(m) => (
							<SelectItem key={m} value={m}>
								{SERVICE_METRIC[m].label}
							</SelectItem>
						),
					)}
				</SelectContent>
			</Select>
			<div className="dim relative">
				<Input
					type="number"
					min={1}
					max={t.metric === "memoryPercent" ? 100 : undefined}
					value={Number.isNaN(t.above) ? "" : t.above}
					onChange={(e) => onChange({ above: e.target.valueAsNumber })}
					aria-label={`Limit in ${meta.unit}`}
					aria-invalid={error ? true : undefined}
					className="pr-20 tabular"
				/>
				<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
					{meta.unit}
				</span>
			</div>
			<Select
				value={String(t.forSec)}
				onValueChange={(v) => onChange({ forSec: Number(v) })}
			>
				<SelectTrigger className="dim w-full" aria-label="Averaged over">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{(WINDOWS.includes(t.forSec)
						? WINDOWS
						: [...WINDOWS, t.forSec].sort((a, b) => a - b)
					).map((s) => (
						<SelectItem key={s} value={String(s)}>
							{minutes(s)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{!lead && (
				<span className="min-w-0">
					{t.firing && t.enabled && (
						<StatusLabel meta={FIRING} className="text-xs" />
					)}
				</span>
			)}
			<div className="flex items-center justify-end gap-2">
				{lead && t.firing && t.enabled && (
					<StatusLabel meta={FIRING} className="text-xs" />
				)}
				<Switch
					checked={t.enabled}
					onCheckedChange={(enabled) => onChange({ enabled })}
					aria-label={t.enabled ? "Enabled" : "Disabled"}
				/>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Remove ${meta.label} threshold`}
					onClick={onRemove}
				>
					<X />
				</Button>
			</div>
			{error && (
				<p className="text-xs text-bad-text sm:col-span-5">Limit: {error}</p>
			)}
		</li>
	);
}
