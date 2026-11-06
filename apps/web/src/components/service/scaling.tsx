import type { AutoscaleBehavior } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { Slider } from "radix-ui";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { AnimatedNumber } from "@/components/animated-number";
import { MetricChart, seriesColor } from "@/components/charts/metric-chart";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import {
	type AutoscaleView,
	autoscalePreviewQuery,
	autoscaleQuery,
	useSaveAutoscale,
} from "@/lib/api/autoscale";
import type { ServiceOverview } from "@/lib/api/service-ops";
import type { ProjectId } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const MAX = 20;

const BEHAVIORS: {
	value: AutoscaleBehavior;
	title: string;
	description: string;
	target?: number;
}[] = [
	{
		value: "balanced",
		title: "Balanced",
		description:
			"Adds a copy when copies run above 60% CPU. Right for most web apps.",
		target: 60,
	},
	{
		value: "responsive",
		title: "Responsive",
		description:
			"Adds copies early, at 45% CPU. Fastest under sudden traffic, uses more resources.",
		target: 45,
	},
	{
		value: "economical",
		title: "Economical",
		description:
			"Runs as few copies as it can, up to 75% CPU each. Can be slower during spikes.",
		target: 75,
	},
	{
		value: "custom",
		title: "Custom target",
		description: "Choose the CPU level each copy should stay around.",
	},
];

const behaviorLabel = (b: AutoscaleBehavior, target: number) =>
	b === "custom"
		? `Custom, CPU target ${target}%`
		: `${BEHAVIORS.find((x) => x.value === b)?.title}, CPU target ${target}%`;

const copies = (n: number) => `${n} ${n === 1 ? "copy" : "copies"}`;

/** "6 CPU and 3 GB": the per-copy limits times `max`. */
function costLine(o: ServiceOverview, max: number) {
	const r = o.spec.kind === "compose" ? {} : o.spec.resources;
	const parts = [
		r.cpu && `${+(r.cpu * max).toFixed(2)} CPU`,
		r.memoryMb &&
			(r.memoryMb * max >= 1024
				? `${+((r.memoryMb * max) / 1024).toFixed(1)} GB`
				: `${r.memoryMb * max} MB`),
	].filter(Boolean);
	return parts.length ? parts.join(" and ") : undefined;
}

function Checks({ checks }: { checks: AutoscaleView["checks"] }) {
	return (
		<ul className="grid gap-3">
			{checks.map((c) => {
				const Icon = c.ok
					? CircleCheck
					: c.level === "blocker"
						? CircleX
						: CircleAlert;
				return (
					<li key={c.id} className="flex items-start gap-2.5 text-sm">
						<Icon
							aria-hidden
							strokeWidth={1.75}
							className={cn(
								"mt-0.5 size-4 shrink-0",
								c.ok
									? "text-ok-text"
									: c.level === "blocker"
										? "text-bad-text"
										: "text-warn-text",
							)}
						/>
						<span
							className={cn("text-pretty", c.ok && "text-muted-foreground")}
						>
							<span className="sr-only">
								{c.ok
									? "Passed: "
									: c.level === "blocker"
										? "Blocks: "
										: "Warning: "}
							</span>
							{c.message}
						</span>
					</li>
				);
			})}
		</ul>
	);
}

/** Two thumbs on one track, 1 to 20 copies; arrow keys move the focused thumb. */
function RangeSlider({
	value,
	onChange,
}: {
	value: [number, number];
	onChange: (v: [number, number]) => void;
}) {
	return (
		<div className="grid gap-3">
			<Slider.Root
				min={1}
				max={MAX}
				step={1}
				minStepsBetweenThumbs={0}
				value={value}
				onValueChange={(v) => onChange([v[0] ?? 1, v[1] ?? 1])}
				className="relative flex h-6 w-full touch-none items-center select-none"
			>
				<Slider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-muted">
					<Slider.Range className="absolute h-full bg-foreground" />
				</Slider.Track>
				{(["Minimum copies", "Maximum copies"] as const).map((label) => (
					<Slider.Thumb
						key={label}
						aria-label={label}
						className="relative block size-5 rounded-full bg-background shadow-card ring-2 ring-foreground outline-none after:absolute after:-inset-3 after:content-[''] transition-[box-shadow] duration-(--duration-quick) hover:ring-4 hover:ring-foreground/20 focus-visible:ring-4 focus-visible:ring-ring"
					/>
				))}
			</Slider.Root>
			{/* Thumbs stay inside the track, so tick n sits at (n-1)/(MAX-1) of the width less one thumb. */}
			<div
				aria-hidden
				className="relative mx-2.5 h-4 text-2xs text-muted-foreground tabular"
			>
				{[1, 5, 10, 15, MAX].map((n) => (
					<span
						key={n}
						className="absolute -translate-x-1/2"
						style={{ left: `${((n - 1) / (MAX - 1)) * 100}%` }}
					>
						{n}
					</span>
				))}
			</div>
		</div>
	);
}

type Values = {
	minReplicas: number;
	maxReplicas: number;
	behavior: AutoscaleBehavior;
	targetCpu: number;
};

const targetOf = (v: Values) =>
	BEHAVIORS.find((b) => b.value === v.behavior)?.target ?? v.targetCpu;

/** What the settings would have done yesterday: copies over time, and CPU per copy against the target. */
function Preview({ serviceId, v }: { serviceId: string; v: Values }) {
	const target = targetOf(v);
	const { data, isError } = useQuery(
		autoscalePreviewQuery(serviceId, {
			minReplicas: v.minReplicas,
			maxReplicas: v.maxReplicas,
			behavior: v.behavior,
			...(v.behavior === "custom" && { targetCpu: v.targetCpu }),
		}),
	);
	// Five-minute buckets: the most copies in each, and their average CPU.
	const rows = useMemo(() => {
		if (!data) return undefined;
		const out: { t: number; replicas: number; cpu: number; target: number }[] =
			[];
		for (let i = 0; i < data.points.length; i += 5) {
			const chunk = data.points.slice(i, i + 5);
			out.push({
				t: new Date(chunk[0]?.at ?? 0).getTime(),
				replicas: Math.max(...chunk.map((p) => p.replicas)),
				cpu: chunk.reduce((a, p) => a + p.cpu, 0) / chunk.length,
				target,
			});
		}
		return out;
	}, [data, target]);
	const window =
		rows?.length && rows[0] && rows.at(-1)
			? { from: rows[0].t, to: (rows.at(-1) as { t: number }).t }
			: undefined;
	if (isError)
		return (
			<p className="text-sm text-muted-foreground">
				The preview isn't available right now. Your settings still save.
			</p>
		);
	if (data && !data.enoughData)
		return (
			<p className="rounded-lg bg-muted/60 p-4 text-sm text-muted-foreground text-pretty dark:bg-muted/40">
				Not enough history for a preview yet. It appears once the service has
				run for an hour or so.
			</p>
		);
	const span = rows?.length
		? [
				Math.min(...rows.map((r) => r.replicas)),
				Math.max(...rows.map((r) => r.replicas)),
			]
		: undefined;
	return (
		<div className="grid gap-3">
			<p className="text-sm text-pretty">
				{span ? (
					span[0] === span[1] ? (
						<>
							Over the last day this service would have run{" "}
							<strong className="font-medium">
								{copies(span[0] as number)}
							</strong>{" "}
							the whole time.
						</>
					) : (
						<>
							Over the last day this service would have run between{" "}
							<strong className="font-medium tabular">{span[0]}</strong> and{" "}
							<strong className="font-medium tabular">
								{copies(span[1] as number)}
							</strong>
							.
						</>
					)
				) : (
					<span className="text-muted-foreground">Replaying the last day…</span>
				)}
			</p>
			<div className="grid gap-3 lg:grid-cols-2">
				<MetricChart
					title="Copies"
					rows={rows}
					series={[{ key: "replicas", label: "Copies", color: seriesColor(0) }]}
					format={(n) => String(Math.round(n))}
					range="24h"
					window={window}
					domain={[0, Math.max(v.maxReplicas, 1)]}
					curve="step"
					empty="No history yet"
					height={140}
				/>
				<MetricChart
					title="CPU per copy"
					rows={rows}
					series={[
						{ key: "cpu", label: "CPU", color: seriesColor(0) },
						{
							key: "target",
							label: "Target",
							color: "var(--muted-foreground)",
							dashed: true,
						},
					]}
					format={(n) => `${Math.round(n)}%`}
					range="24h"
					window={window}
					domain={[0, 100]}
					empty="No history yet"
					height={140}
				/>
			</div>
		</div>
	);
}

export function AutoscaleWizard({
	service: o,
	view,
	step,
	onStepChange,
	onDone,
}: {
	service: ServiceOverview;
	view: AutoscaleView;
	step: string | undefined;
	onStepChange: (id: string, opts: { replace: boolean }) => void;
	onDone: () => void;
}) {
	const save = useSaveAutoscale(o.id);
	const blockers = view.checks.filter((c) => c.level === "blocker" && !c.ok);
	const steps: WizardStep<Values>[] = [
		{
			id: "ready",
			title: "Check the service",
			description:
				"Copies of a service must be interchangeable, and each needs a CPU limit to measure against.",
			ready: () =>
				blockers.length
					? `Fix ${blockers.length === 1 ? "the check marked in red" : "the checks marked in red"} in the service settings first.`
					: true,
			render: () => <Checks checks={view.checks} />,
		},
		{
			id: "range",
			title: "How many copies",
			description:
				"It never runs fewer than the minimum, even when idle, and never more than the maximum, even under a spike.",
			schema: z
				.object({ minReplicas: z.number(), maxReplicas: z.number() })
				.refine((v) => v.minReplicas <= v.maxReplicas),
			render: (w) => {
				const cost = costLine(o, w.values.maxReplicas);
				return (
					<div className="grid max-w-xl gap-6">
						<p
							className="text-2xl font-semibold tabular [font-stretch:108%]"
							aria-live="polite"
						>
							{w.values.minReplicas === w.values.maxReplicas
								? `Always ${copies(w.values.minReplicas)}`
								: `Between ${w.values.minReplicas} and ${copies(w.values.maxReplicas)}`}
						</p>
						<RangeSlider
							value={[w.values.minReplicas, w.values.maxReplicas]}
							onChange={([min, max]) => {
								w.set("minReplicas", min);
								w.set("maxReplicas", max);
							}}
						/>
						{cost && (
							<p className="text-sm text-muted-foreground">
								At the maximum this service uses{" "}
								<span className="text-foreground tabular">{cost}</span>, so the
								servers need that much to spare.
							</p>
						)}
					</div>
				);
			},
		},
		{
			id: "behavior",
			title: "How quickly it reacts",
			description:
				"Copies are added within a minute when CPU climbs past the target, and removed one at a time once it has stayed low for five minutes.",
			schema: (v) =>
				v.behavior === "custom"
					? z.object({
							targetCpu: z
								.number({ message: "Enter a percentage" })
								.int("Whole numbers only")
								.min(10, "At least 10%")
								.max(95, "At most 95%"),
						})
					: z.object({}),
			render: (w) => (
				<div className="grid gap-4">
					<ChoiceGroup
						label="Behavior"
						value={w.values.behavior}
						onChange={(b) => w.set("behavior", b)}
						choices={BEHAVIORS.map((b) => ({
							value: b.value,
							title: b.title,
							description: b.description,
							...(b.value === "balanced" && { badge: "Recommended" }),
						}))}
						columns={2}
					/>
					{w.values.behavior === "custom" && (
						<Field
							id="targetCpu"
							label="CPU target"
							hint="Percent of each copy's CPU limit, 10 to 95."
							error={w.error("targetCpu")}
							className="max-w-48"
						>
							<Input
								{...w.bind("targetCpu")}
								type="number"
								inputMode="numeric"
								min={10}
								max={95}
								onChange={(e) =>
									w.set("targetCpu", Number(e.target.value) as number)
								}
							/>
						</Field>
					)}
				</div>
			),
		},
		{
			id: "review",
			title: "Review",
			description:
				"A replay of the last day with these settings, then turn it on.",
			render: (w) => (
				<div className="grid gap-6">
					<Summary
						w={w}
						sections={[
							{
								stepId: "range",
								title: "Copies",
								rows: [
									{ label: "Minimum", value: copies(w.values.minReplicas) },
									{ label: "Maximum", value: copies(w.values.maxReplicas) },
								],
							},
							{
								stepId: "behavior",
								title: "Behavior",
								rows: [
									{
										label: "Reacts",
										value: behaviorLabel(w.values.behavior, targetOf(w.values)),
									},
								],
							},
						]}
					/>
					<Preview serviceId={o.id} v={w.values} />
				</div>
			),
		},
	];
	return (
		<Wizard
			id={`autoscale:${o.id}`}
			steps={steps}
			defaultValues={{
				minReplicas: view.minReplicas,
				maxReplicas: view.maxReplicas,
				behavior: view.behavior,
				targetCpu: view.targetCpu,
			}}
			step={step}
			onStepChange={onStepChange}
			finishLabel={view.enabled ? "Save changes" : "Turn on automatic scaling"}
			onComplete={async (v) => {
				await save.mutateAsync({
					enabled: true,
					minReplicas: v.minReplicas,
					maxReplicas: v.maxReplicas,
					behavior: v.behavior,
					...(v.behavior === "custom" && { targetCpu: v.targetCpu }),
					targetMemory: null,
				});
				toast.success(
					view.enabled ? "Scaling saved" : "Automatic scaling is on",
					{
						description: `${o.name} runs between ${v.minReplicas} and ${copies(v.maxReplicas)}.`,
					},
				);
				onDone();
			}}
		/>
	);
}

/**
 * Fixed or automatic copies. Fixed edits `spec.replicas` with the rest of the form; automatic
 * shows what the autoscaler is doing and links to its wizard.
 */
export function ScalingSection({
	service: o,
	projectId,
	replicas,
	onReplicas,
}: {
	service: ServiceOverview;
	projectId: ProjectId;
	replicas: number;
	onReplicas: (n: number) => void;
}) {
	const { data: view } = useQuery(autoscaleQuery(o.id));
	const save = useSaveAutoscale(o.id);
	const [mode, setMode] = useState<"fixed" | "auto" | undefined>();
	const current = mode ?? (view?.enabled ? "auto" : "fixed");
	const setup = {
		to: "/projects/$projectId/services/$serviceId/settings",
		params: { projectId, serviceId: o.id },
		search: { scaling: "setup" as const },
	};

	return (
		<div className="grid gap-5">
			<div>
				<Segmented
					label="Scaling"
					value={current}
					onChange={setMode}
					options={[
						{ value: "fixed", label: "Fixed" },
						{ value: "auto", label: "Automatic" },
					]}
				/>
			</div>

			{current === "fixed" && !view?.enabled && (
				<Field
					id="replicas"
					label="Copies"
					hint="Always runs this many. Saved with the rest of the form."
					className="max-w-48"
				>
					<Input
						id="replicas"
						type="number"
						min={0}
						value={replicas}
						onChange={(e) =>
							onReplicas(
								e.target.value.trim() === "" ? 0 : Number(e.target.value),
							)
						}
					/>
				</Field>
			)}

			{current === "fixed" && view?.enabled && (
				<div className="grid max-w-[70ch] gap-3 rounded-lg bg-muted/60 p-4 text-sm dark:bg-muted/40">
					<p className="text-pretty">
						Automatic scaling is on. Switching to fixed runs{" "}
						<strong className="font-medium">
							{copies(o.spec.kind === "application" ? o.spec.replicas : 1)}
						</strong>{" "}
						all the time, as set before it was turned on.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							disabled={save.isPending}
							onClick={() =>
								save.mutate(
									{
										enabled: false,
										minReplicas: view.minReplicas,
										maxReplicas: view.maxReplicas,
										behavior: view.behavior,
										...(view.behavior === "custom" && {
											targetCpu: view.targetCpu,
										}),
										targetMemory: view.targetMemory,
									},
									{
										onSuccess: () => toast.success("Automatic scaling is off"),
										onError: (e) =>
											toast.error("Couldn't turn it off", {
												description: e.message,
											}),
									},
								)
							}
						>
							Switch to fixed
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setMode("auto")}>
							Keep automatic
						</Button>
					</div>
				</div>
			)}

			{current === "auto" && view?.enabled && (
				<div className="grid max-w-[70ch] gap-4">
					<div className="grid gap-1">
						<p className="text-base font-medium tabular" aria-live="polite">
							Running{" "}
							<AnimatedNumber value={view.replicas ?? view.minReplicas} />{" "}
							{(view.replicas ?? view.minReplicas) === 1 ? "copy" : "copies"}{" "}
							now, between {view.minReplicas} and {view.maxReplicas}.
						</p>
						<p className="text-sm text-muted-foreground text-pretty">
							{behaviorLabel(view.behavior, view.targetCpu)}.{" "}
							{view.lastScaledAt && view.lastReason
								? `Last change ${relativeTime(String(view.lastScaledAt))}: ${view.lastReason}.`
								: "No change yet; the first decision comes within a minute."}
						</p>
					</div>
					<div>
						<Button asChild size="sm" variant="outline">
							<Link {...setup}>Edit scaling</Link>
						</Button>
					</div>
				</div>
			)}

			{current === "auto" && view && !view.enabled && (
				<div className="grid max-w-[70ch] gap-4">
					<p className="text-sm text-pretty">
						Adds copies when the service is busy and removes them when it's
						quiet, between limits you choose. A short setup checks the service,
						then shows what it would have done over the last day.
					</p>
					<div>
						<Button asChild size="sm">
							<Link {...setup}>Set up automatic scaling</Link>
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
