import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { type AiCapacity, aiCapacityQuery, formatCount } from "@/lib/api/ai";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatAllowances, formatAmount, TIER_COLOR } from "./parts";

type Row = AiCapacity["providers"][number];
type Live = Row["live"][number];

/** What is left of a daily figure; providers without one add nothing. */
const left = (rows: Row[], unit: "tokens" | "requests") =>
	rows.reduce(
		(n, p) =>
			p.daily[unit] > 0
				? n + Math.max(0, p.daily[unit] - p.usedToday[unit])
				: n,
		0,
	);

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** How much of the connected providers' published free tiers is left today. */
export function FreeCapacity({ canAdmin }: { canAdmin: boolean }) {
	const { data } = useQuery(aiCapacityQuery);
	return (
		<section aria-labelledby="capacity-heading" className="grid gap-4">
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
				<div className="grid gap-1">
					<h2 id="capacity-heading" className="text-md font-semibold">
						Free capacity today
					</h2>
					<p className="max-w-[70ch] text-sm text-pretty text-muted-foreground">
						What the free providers you connected publish as their daily
						allowance, across every healthy key, minus what the gateway used
						today.
					</p>
				</div>
				<p className="text-xs text-muted-foreground">Resets at 00:00 UTC</p>
			</div>
			<div className="min-w-0 overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				{!data ? (
					<CapacitySkeleton />
				) : data.providers.length === 0 ? (
					<div className="grid justify-items-start gap-2 p-5">
						<p className="text-sm font-medium">No free provider connected</p>
						<p className="max-w-[60ch] text-sm text-pretty text-muted-foreground">
							Groq, Cerebras and Gemini publish free daily allowances; connect
							one and its capacity shows up here.
						</p>
						{canAdmin && (
							<Link
								to="/ai/providers/new"
								className="text-sm font-medium underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground"
							>
								Add a provider
							</Link>
						)}
					</div>
				) : (
					<>
						<Summary data={data} />
						<ul className="divide-y border-t" aria-label="Capacity by provider">
							{data.providers.map((p) => (
								<ProviderRow key={p.provider} p={p} />
							))}
						</ul>
					</>
				)}
			</div>
		</section>
	);
}

function Summary({ data }: { data: AiCapacity }) {
	const { totals, providers } = data;
	const tokens = {
		left: left(providers, "tokens"),
		total: totals.tokensPerDay,
		unit: "tokens",
	};
	const requests = {
		left: left(providers, "requests"),
		total: totals.requestsPerDay,
		unit: "requests",
	};
	// Tokens lead; a pool of request-only providers leads with requests instead.
	const [main, side] =
		tokens.total > 0 ? [tokens, requests] : [requests, undefined];
	const unpublished = providers.filter(
		(p) => p.daily.tokens === 0 && p.daily.requests === 0,
	);

	return (
		<div className="grid gap-5 p-5">
			{main.total > 0 ? (
				<div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-end">
					<div className="grid min-w-0 gap-3">
						<p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
							<span className="text-4xl font-semibold tracking-tight tabular [font-stretch:108%]">
								{formatCount(main.left)}
							</span>
							<span className="text-sm text-muted-foreground tabular">
								{main.unit} left of {formatCount(main.total)}
							</span>
						</p>
						<Meter
							value={main.left}
							max={main.total}
							label={`Free ${main.unit} left today`}
							className="h-2"
						/>
					</div>
					{side && side.total > 0 && (
						<div className="grid min-w-0 gap-3">
							<p className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground tabular">
								<span className="text-xl font-semibold text-foreground [font-stretch:108%]">
									{formatAmount(side.left)}
								</span>
								requests left of {formatAmount(side.total)}
							</p>
							<Meter
								value={side.left}
								max={side.total}
								label="Free requests left today"
								className="h-1.5"
							/>
						</div>
					)}
				</div>
			) : (
				<p className="text-sm text-pretty text-muted-foreground">
					None of the connected providers publishes a daily figure, so there is
					no total to show. Their limits are listed below.
				</p>
			)}
			<div className="grid gap-1 text-xs text-pretty text-muted-foreground">
				{unpublished.length > 0 && main.total > 0 && (
					<p>
						{unpublished.length === 1
							? "1 provider doesn't"
							: `${unpublished.length} providers don't`}{" "}
						publish a daily limit and{" "}
						{unpublished.length === 1 ? "isn't" : "aren't"} counted:{" "}
						{unpublished.map((p) => p.name).join(", ")}.
					</p>
				)}
				<p>
					Figures are the providers' published free tiers, which change often;
					the provider's own limit always wins.
				</p>
			</div>
		</div>
	);
}

function ProviderRow({ p }: { p: Row }) {
	const down = p.healthy === 0;
	const limits = (["tokens", "requests"] as const).filter(
		(u) => p.daily[u] > 0,
	);
	return (
		<li className="grid gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_14rem_auto]">
			<div className="grid min-w-0 gap-1">
				<p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
					<span className="font-medium text-sm">{p.name}</span>
					<span
						className={cn(
							"text-xs tabular",
							down ? "text-warn-text" : "text-muted-foreground",
						)}
					>
						{down
							? `No healthy key, not counted`
							: p.healthy < p.keys
								? `${p.healthy} of ${plural(p.keys, "key")} healthy`
								: plural(p.keys, "key")}
					</span>
				</p>
				<p className="text-sm text-muted-foreground tabular">
					{formatAllowances(p.limits)}
				</p>
				{p.note && (
					<p className="text-xs text-pretty text-muted-foreground">{p.note}</p>
				)}
				{p.live.length > 0 && (
					<ul className="mt-1 grid gap-1" aria-label={`${p.name} reports`}>
						{p.live.map((l) => (
							<LiveLine key={l.model} l={l} />
						))}
					</ul>
				)}
			</div>
			<div className="grid content-start gap-2 text-sm tabular">
				{limits.map((u) => {
					const rest = Math.max(0, p.daily[u] - p.usedToday[u]);
					return (
						<div key={u} className="grid gap-1">
							<span>
								{formatAmount(rest)}{" "}
								<span className="text-muted-foreground">
									of {formatAmount(p.daily[u])} {u} left
								</span>
							</span>
							<Meter
								value={rest}
								max={p.daily[u]}
								label={`${p.name} ${u} left today`}
								className="h-1"
							/>
						</div>
					);
				})}
				<span className="text-xs text-muted-foreground">
					Used today: {formatAmount(p.usedToday.tokens)} tokens ·{" "}
					{formatAmount(p.usedToday.requests)} requests
				</span>
			</div>
			<div className="sm:text-right">
				{p.docsUrl && (
					<a
						href={p.docsUrl}
						target="_blank"
						rel="noreferrer"
						className="inline-flex h-8 items-center gap-1.5 rounded-md text-xs text-muted-foreground outline-none transition-colors duration-(--duration-quick) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					>
						Limits
						<ExternalLink className="size-3" aria-hidden />
						<span className="sr-only"> for {p.name} (opens in a new tab)</span>
					</a>
				)}
			</div>
		</li>
	);
}

/** One line from the provider's rate-limit headers, e.g. "788 of 1,000 requests left". */
function LiveLine({ l }: { l: Live }) {
	const parts = [
		l.remainingRequests !== undefined &&
			`${formatAmount(l.remainingRequests)}${l.limitRequests !== undefined ? ` of ${formatAmount(l.limitRequests)}` : ""} requests left${l.resetRequests ? `, resets in ${l.resetRequests}` : ""}`,
		l.remainingTokens !== undefined &&
			`${formatAmount(l.remainingTokens)}${l.limitTokens !== undefined ? ` of ${formatAmount(l.limitTokens)}` : ""} tokens left${l.resetTokens ? `, resets in ${l.resetTokens}` : ""}`,
	].filter(Boolean);
	return (
		<li className="text-xs text-pretty text-muted-foreground tabular">
			<span className="font-mono text-foreground">{l.model}</span>{" "}
			{parts.join(" · ")}
			<span className="whitespace-nowrap">
				{" "}
				· reported {relativeTime(l.observedAt)}
			</span>
		</li>
	);
}

function Meter({
	value,
	max,
	label,
	className,
}: {
	value: number;
	max: number;
	label: string;
	className?: string;
}) {
	const pct = max ? Math.min(100, (value / max) * 100) : 0;
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={max}
			aria-valuenow={value}
			className={cn("overflow-hidden rounded-full bg-muted", className)}
		>
			<div
				className="h-full rounded-full transition-[width] duration-(--duration-slow) ease-(--ease-smooth-out)"
				style={{
					width: `${pct}%`,
					background:
						pct <= 5
							? "var(--bad)"
							: pct <= 20
								? "var(--warn)"
								: TIER_COLOR.free,
				}}
			/>
		</div>
	);
}

function CapacitySkeleton() {
	return (
		<div className="grid gap-4 p-5" aria-hidden>
			<span className="t-skel block h-9 w-40 rounded bg-muted-foreground/15" />
			<span className="t-skel block h-2 rounded-full bg-muted-foreground/10" />
			<span className="t-skel block h-3 w-2/3 rounded bg-muted-foreground/10" />
		</div>
	);
}
