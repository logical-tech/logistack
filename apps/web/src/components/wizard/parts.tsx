import {
	CircleAlert,
	CircleCheck,
	ExternalLink,
	Loader2,
	type LucideIcon,
} from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WizardApi, WizardValues } from "./wizard";

export type Choice<T extends string> = {
	value: T;
	title: string;
	description: string;
	icon?: LucideIcon;
	badge?: string;
};

/** Radio cards: arrow keys move, Space selects, the whole card is the hit area. */
export function ChoiceGroup<T extends string>({
	value,
	onChange,
	choices,
	label,
	columns = 2,
	invalid,
	footer,
}: {
	value: T | undefined;
	onChange: (value: T) => void;
	choices: Choice<T>[];
	label: string;
	columns?: 1 | 2 | 4;
	invalid?: boolean;
	/** Rendered after the radio cards, outside the radio group (e.g. a link to another flow). */
	footer?: ReactNode;
}) {
	const group = (
		<RadioGroupPrimitive.Root
			value={value}
			onValueChange={(v) => onChange(v as T)}
			aria-label={label}
			aria-invalid={invalid || undefined}
			className={cn(
				"grid gap-2",
				columns === 2 && "sm:grid-cols-2",
				columns === 4 && "sm:grid-cols-2 xl:grid-cols-4",
			)}
		>
			{choices.map((c) => {
				const Icon = c.icon;
				return (
					<RadioGroupPrimitive.Item
						key={c.value}
						value={c.value}
						className={cn(
							"group relative flex items-start gap-3 rounded-lg bg-card p-3.5 text-left ring-1 ring-border outline-none t-press",
							"hover:ring-foreground/25 focus-visible:ring-2 focus-visible:ring-ring",
							"data-[state=checked]:ring-2 data-[state=checked]:ring-foreground",
						)}
					>
						{Icon && (
							<span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground transition-colors duration-(--duration-quick) group-data-[state=checked]:bg-foreground group-data-[state=checked]:text-background">
								<Icon className="size-4" strokeWidth={1.75} aria-hidden />
							</span>
						)}
						<span className="min-w-0 flex-1">
							<span className="flex items-center gap-2 text-sm font-medium">
								{c.title}
								{c.badge && (
									<span className="rounded-sm bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground">
										{c.badge}
									</span>
								)}
							</span>
							<span className="mt-0.5 block text-xs text-muted-foreground">
								{c.description}
							</span>
						</span>
						<span
							aria-hidden
							className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full ring-1 ring-input transition-colors duration-(--duration-quick) group-data-[state=checked]:bg-foreground group-data-[state=checked]:ring-foreground"
						>
							<span className="size-1.5 scale-0 rounded-full bg-background transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=checked]:scale-100" />
						</span>
					</RadioGroupPrimitive.Item>
				);
			})}
		</RadioGroupPrimitive.Root>
	);
	return footer ? (
		<div className="grid gap-2">
			{group}
			{footer}
		</div>
	) : (
		group
	);
}

/** The "Test connection" panel every wizard test step renders. */
export function TestPanel<V extends WizardValues>({
	w,
	idle,
	action = "Test connection",
}: {
	w: WizardApi<V>;
	idle: ReactNode;
	action?: string;
}) {
	const t = w.test;
	const result = t.phase === "passed" || t.phase === "failed" ? t.result : null;
	return (
		<div
			className="rounded-lg bg-muted/60 p-4 dark:bg-muted/40"
			aria-live="polite"
		>
			<div className="flex items-start gap-3">
				<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
					{t.phase === "running" && (
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
					)}
					{t.phase === "passed" && (
						<CircleCheck className="t-reveal size-5 text-ok-text" />
					)}
					{t.phase === "failed" && (
						<CircleAlert className="t-reveal size-5 text-bad-text" />
					)}
					{t.phase === "idle" && (
						<span className="size-2 rounded-full bg-idle" />
					)}
				</span>
				<div className="min-w-0 flex-1">
					{t.phase === "idle" && (
						<p className="text-sm text-muted-foreground">{idle}</p>
					)}
					{t.phase === "running" && (
						<p className="text-sm text-muted-foreground">Testing…</p>
					)}
					{result && (
						<div key={result.message} className="t-swap">
							<p
								className={cn(
									"text-sm font-medium",
									result.ok ? "text-foreground" : "text-bad-text",
								)}
							>
								{result.message}
							</p>
							{result.detail && (
								<p className="mt-0.5 text-sm text-muted-foreground">
									{result.detail}
								</p>
							)}
						</div>
					)}
				</div>
				<Button
					type="button"
					variant={t.phase === "passed" ? "ghost" : "outline"}
					onClick={w.runTest}
					disabled={t.phase === "running"}
				>
					{t.phase === "failed" || t.phase === "passed" ? "Test again" : action}
				</Button>
			</div>
		</div>
	);
}

export type SummarySection = {
	stepId: string;
	title: string;
	rows: { label: string; value: ReactNode }[];
};

export function Summary<V extends WizardValues>({
	w,
	sections,
}: {
	w: WizardApi<V>;
	sections: SummarySection[];
}) {
	return (
		<div className="divide-y rounded-lg bg-card ring-1 ring-border">
			{sections.map((s) => (
				<section key={s.stepId} className="px-4 py-3.5">
					<div className="mb-2 flex items-center justify-between">
						<h3 className="text-sm font-medium">{s.title}</h3>
						<Button
							type="button"
							variant="link"
							size="sm"
							className="h-auto px-0 text-muted-foreground hover:text-foreground"
							onClick={() => w.goTo(s.stepId)}
						>
							Edit
						</Button>
					</div>
					<dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
						{s.rows.map((r) => (
							<div key={r.label} className="contents">
								<dt className="text-muted-foreground">{r.label}</dt>
								<dd className="min-w-0 break-words">{r.value}</dd>
							</div>
						))}
					</dl>
				</section>
			))}
		</div>
	);
}

/** Grey box for the "where do I get this" instructions next to a credential. */
export function Instructions({
	children,
	href,
	link,
}: {
	children: ReactNode;
	href?: string;
	link?: string;
}) {
	return (
		<div className="rounded-lg bg-muted/60 p-4 text-sm dark:bg-muted/40">
			<div className="grid gap-2 text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
				{children}
			</div>
			{href && link && (
				<Button asChild variant="outline" size="sm" className="mt-3">
					<a href={href} target="_blank" rel="noreferrer">
						{link}
						<ExternalLink data-icon="inline-end" />
					</a>
				</Button>
			)}
		</div>
	);
}
