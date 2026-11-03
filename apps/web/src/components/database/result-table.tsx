import type {
	QueryColumn,
	QueryError,
	StatementResult,
} from "@logistack/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CircleAlert, Copy } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { SlidingTabs } from "@/components/sliding-tabs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isNumeric, shortType, toCsv, toJson } from "./cells";
import { CellView, widthOf } from "./data-grid";

const ROW = 32;
const GUTTER = 52;
const count = new Intl.NumberFormat("en");

const plural = (n: number, one: string, many = `${one}s`) =>
	`${count.format(n)} ${n === 1 ? one : many}`;

const VERBS: Record<string, string> = {
	INSERT: "inserted",
	UPDATE: "updated",
	DELETE: "deleted",
	MERGE: "merged",
	COPY: "copied",
};

/** What a statement did, in a sentence: "3 rows updated", "CREATE TABLE done". */
function outcome(r: StatementResult) {
	const verb = VERBS[r.command];
	if (verb && r.affected !== null)
		return `${plural(r.affected, "row")} ${verb}`;
	return `${r.command} done`;
}

/** The caller stopped it; not a failure of their SQL. */
const cancelled = (e: QueryError) =>
	e.code === "57014" && e.message.includes("user request");

const ms = (n: number) =>
	n < 1000
		? `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`
		: `${(n / 1000).toFixed(2)} s`;

export type RunOutcome = {
	results: StatementResult[];
	error: QueryError | null;
	/** The SQL that ran, for tab labels. */
	sql: string;
	readOnly: boolean;
};

/** One tab per statement, plus the error when one failed. */
export function ResultTabs({
	run,
	tab,
	onTab,
}: {
	run: RunOutcome;
	tab: number;
	onTab: (tab: number) => void;
}) {
	const { results, error } = run;
	const items = [
		...results.map((r, i) => ({
			id: String(i),
			label: (
				<>
					<span className="font-medium" title={run.sql.slice(r.from, r.to)}>
						{r.command}
					</span>
					{r.columns.length > 0 && (
						<span className="text-xs text-muted-foreground tabular">
							{count.format(r.rows.length)}
							{r.truncated ? "+" : ""}
						</span>
					)}
				</>
			),
		})),
		...(error
			? [
					{
						id: String(results.length),
						label: cancelled(error) ? (
							<span className="font-medium">Cancelled</span>
						) : (
							<span className="flex items-center gap-1.5 font-medium text-bad-text">
								<CircleAlert className="size-3.5" aria-hidden />
								Error
							</span>
						),
					},
				]
			: []),
	];
	const current = results[tab];
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex min-h-11 flex-wrap items-end gap-x-3 border-b px-2 sm:px-3">
				<div className="min-w-0 flex-1">
					<SlidingTabs
						items={items}
						value={String(tab)}
						onChange={(id) => onTab(Number(id))}
						label="Statement results"
						idPrefix="sql-result"
					/>
				</div>
				{current && (
					<div className="flex items-center gap-1 self-center py-1.5 text-xs text-muted-foreground">
						<span className="tabular">
							{current.columns.length
								? plural(current.rows.length, "row")
								: outcome(current)}
							<span className="mx-1.5 text-border">·</span>
							{ms(current.durationMs)}
						</span>
						{current.columns.length > 0 && (
							<>
								<CopyAs
									label="CSV"
									text={() => toCsv(current.columns, current.rows)}
									rows={current.rows.length}
								/>
								<CopyAs
									label="JSON"
									text={() => toJson(current.columns, current.rows)}
									rows={current.rows.length}
								/>
							</>
						)}
					</div>
				)}
			</div>
			<div
				id="sql-result-panel"
				role="tabpanel"
				aria-labelledby={`sql-result-tab-${tab}`}
				className="flex min-h-0 flex-1 flex-col"
			>
				{current ? (
					<StatementView key={tab} result={current} />
				) : error ? (
					<ErrorView error={error} run={run} />
				) : null}
			</div>
		</div>
	);
}

function CopyAs({
	label,
	text,
	rows,
}: {
	label: string;
	text: () => string;
	rows: number;
}) {
	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-7 gap-1 px-2 text-xs text-muted-foreground"
			aria-label={`Copy as ${label}`}
			onClick={() =>
				navigator.clipboard.writeText(text()).then(
					() => toast.success(`Copied ${plural(rows, "row")} as ${label}`),
					() =>
						toast.error("Couldn't copy", {
							description: "The browser blocked clipboard access.",
						}),
				)
			}
		>
			<Copy className="size-3" aria-hidden />
			{label}
		</Button>
	);
}

function ErrorView({ error, run }: { error: QueryError; run: RunOutcome }) {
	const timedOut =
		error.code === "57014" && error.message.includes("statement timeout");
	return (
		<div className="t-reveal flex flex-col gap-2 overflow-auto px-4 py-5 sm:px-5">
			{cancelled(error) ? (
				<p role="status" className="text-sm">
					You cancelled the run at statement {error.statement + 1}.
				</p>
			) : (
				<p
					role="alert"
					className="max-w-[72ch] font-mono text-[13px] leading-relaxed text-bad-text"
				>
					{error.message}
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				Statement {error.statement + 1}
				{error.code && <> · SQLSTATE {error.code}</>}
				{error.position !== undefined && <> · underlined in the editor</>}
				{timedOut && <> · statements stop after 30 seconds</>}
			</p>
			{error.code === "25006" && (
				<p className="text-xs text-muted-foreground">
					Turn off Read only to run statements that write.
				</p>
			)}
			{!run.readOnly && (
				<p className="text-xs text-muted-foreground">
					The run rolled back, so nothing it wrote was saved.
				</p>
			)}
		</div>
	);
}

/** Rows of one statement, virtualized, with typed headers. */
function StatementView({ result }: { result: StatementResult }) {
	const scroller = useRef<HTMLDivElement>(null);
	const { columns, rows } = result;
	const virtual = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scroller.current,
		estimateSize: () => ROW,
		overscan: 16,
	});

	if (!columns.length)
		return (
			<div className="t-reveal grid flex-1 place-items-center px-6 py-10 text-center">
				<p className="text-sm text-muted-foreground">{outcome(result)}.</p>
			</div>
		);

	const widths = columns.map((c) => Math.min(widthOf(c), 360));
	const template = `${GUTTER}px ${widths.map((w) => `${w}px`).join(" ")}`;
	const total = GUTTER + widths.reduce((a, b) => a + b, 0);

	return (
		<>
			{result.truncated && (
				<p className="border-b bg-[color-mix(in_oklab,var(--card),var(--warn)_10%)] px-4 py-1.5 text-xs text-warn-text">
					Showing the first {count.format(rows.length)} rows. Add a{" "}
					<code className="font-mono">limit</code> or a{" "}
					<code className="font-mono">where</code> to see the rest.
				</p>
			)}
			<div
				ref={scroller}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the scroller is how keyboard users pan a wide result
				tabIndex={0}
				className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			>
				<table
					aria-rowcount={rows.length + 1}
					className="grid text-sm"
					style={{ width: total, minWidth: "100%" }}
				>
					<thead className="sticky top-0 z-20 grid">
						<tr
							className="grid border-b bg-card"
							style={{
								gridTemplateColumns: template,
								width: total,
								minWidth: "100%",
							}}
						>
							<th className="sticky left-0 z-10 bg-card" aria-label="Row" />
							{columns.map((c, i) => (
								<HeaderCell
									// biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; position is the identity
									key={i}
									column={c}
								/>
							))}
						</tr>
					</thead>
					{rows.length === 0 ? (
						<tbody className="block">
							<tr className="block">
								<td className="block px-6 py-14 text-center text-sm text-muted-foreground">
									No rows.
								</td>
							</tr>
						</tbody>
					) : (
						<tbody
							className="relative block"
							style={{
								height: virtual.getTotalSize(),
								width: total,
								minWidth: "100%",
							}}
						>
							{virtual.getVirtualItems().map((v) => {
								const row = rows[v.index] ?? [];
								return (
									<tr
										key={v.index}
										aria-rowindex={v.index + 2}
										className="absolute top-0 left-0 grid border-b border-border/60 bg-card hover:bg-[color-mix(in_oklab,var(--card),var(--foreground)_3%)]"
										style={{
											gridTemplateColumns: template,
											width: "100%",
											minWidth: total,
											height: ROW,
											transform: `translateY(${v.start}px)`,
										}}
									>
										<td className="sticky left-0 z-[5] flex items-center justify-end bg-inherit pr-3 text-xs text-muted-foreground/80 tabular">
											{v.index + 1}
										</td>
										{columns.map((c, i) => (
											<td
												// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
												key={i}
												className={cn(
													"flex min-w-0 items-center px-3",
													isNumeric(c.type) && "justify-end text-right tabular",
												)}
											>
												<CellView value={row[i] ?? null} column={c} />
											</td>
										))}
									</tr>
								);
							})}
						</tbody>
					)}
				</table>
			</div>
		</>
	);
}

function HeaderCell({ column }: { column: QueryColumn }) {
	return (
		<th
			scope="col"
			title={`${column.name} ${column.type}`}
			className={cn(
				"flex h-9 min-w-0 items-center gap-1.5 px-3 text-left text-xs",
				isNumeric(column.type) && "justify-end text-right",
			)}
		>
			<span className="truncate font-medium">{column.name}</span>
			<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
				{shortType(column.type)}
			</span>
		</th>
	);
}
