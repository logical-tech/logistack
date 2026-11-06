import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	memoryMetric,
	ServiceThresholdRow,
} from "@/components/monitoring/service-threshold-row";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	serviceThresholdsQuery,
	useSaveServiceThresholds,
} from "@/lib/api/monitoring";
import type { ServiceOverview } from "@/lib/api/service-ops";
import type { ServiceThresholdsInput } from "@/lib/api/types";

type Draft = ServiceThresholdsInput["thresholds"];

const limitError = (t: Draft[number]) =>
	!Number.isFinite(t.above) || t.above <= 0
		? "enter a number above 0"
		: t.metric === "memoryPercent" && t.above > 100
			? "a percent of the limit is at most 100"
			: undefined;

/** CPU and memory alerts for one service; saved on their own, apart from the spec. */
export function ServiceAlerts({ service: o }: { service: ServiceOverview }) {
	const { data: saved } = useQuery(serviceThresholdsQuery(o.id));
	const save = useSaveServiceThresholds(o.id);
	const [draft, setDraft] = useState<Draft>();
	const [attempted, setAttempted] = useState(false);
	useEffect(() => {
		if (saved && !draft) setDraft(saved.map(({ serviceId: _, ...t }) => t));
	}, [saved, draft]);

	const memoryMb =
		o.spec.kind === "compose" ? undefined : o.spec.resources.memoryMb;
	const baseline = saved?.map(({ serviceId: _, ...t }) => t);
	const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
	const set = (i: number, patch: Partial<Draft[number]>) =>
		setDraft(draft?.map((t, j) => (j === i ? { ...t, ...patch } : t)));
	const invalid = draft?.some((t) => limitError(t));

	return (
		<Panel
			id="alerts"
			title="Alerts"
			actions={
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground"
					disabled={!draft}
					onClick={() =>
						setDraft([
							...(draft ?? []),
							{
								metric: memoryMetric(memoryMb),
								above: memoryMb ? 90 : 512,
								forSec: 300,
								enabled: true,
							},
						])
					}
				>
					<Plus data-icon="inline-start" />
					Add threshold
				</Button>
			}
		>
			<p className="border-b px-4 py-3 text-sm text-muted-foreground">
				{memoryMb
					? `Memory reads against the ${memoryMb} MB limit, per replica.`
					: "No memory limit is set, so memory reads in MB, per replica."}{" "}
				Crossing a limit emits{" "}
				<code className="font-mono text-xs text-foreground">
					service.threshold
				</code>{" "}
				for your{" "}
				<Link
					to="/integrations/notifications"
					className="text-foreground underline decoration-border hover:decoration-foreground"
				>
					notification rules
				</Link>
				, as does a crash loop.
			</p>
			{!draft ? (
				<SkeletonRows rows={1} />
			) : draft.length === 0 ? (
				<p className="px-4 py-4 text-sm text-muted-foreground">
					No thresholds. Add one to hear when this service runs hot.
				</p>
			) : (
				<ul className="divide-y">
					{draft.map((t, i) => (
						<ServiceThresholdRow
							key={t.id ?? `new-${i}`}
							value={t}
							onChange={(patch) => set(i, patch)}
							onRemove={() => setDraft(draft.filter((_, j) => j !== i))}
							error={attempted ? limitError(t) : undefined}
						/>
					))}
				</ul>
			)}
			{dirty && draft && (
				<div className="t-reveal flex items-center justify-end gap-2 border-t px-4 py-3">
					<Button
						variant="ghost"
						disabled={save.isPending}
						onClick={() => {
							setDraft(baseline);
							setAttempted(false);
						}}
					>
						Discard
					</Button>
					<Button
						disabled={save.isPending}
						onClick={() => {
							setAttempted(true);
							if (invalid) return;
							save.mutate(
								{ thresholds: draft },
								{
									onSuccess: (rows) => {
										setDraft(rows.map(({ serviceId: _, ...t }) => t));
										setAttempted(false);
										toast.success("Alerts saved");
									},
									onError: (e) =>
										toast.error("Couldn't save", { description: e.message }),
								},
							);
						}}
					>
						Save alerts
					</Button>
				</div>
			)}
		</Panel>
	);
}
