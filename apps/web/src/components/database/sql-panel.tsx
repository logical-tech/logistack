import type { DatabaseSchema } from "@logistack/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api";
import { databaseApi } from "@/lib/api/database";
import { cn } from "@/lib/utils";
import { ResultTabs, type RunOutcome } from "./result-table";
import { SqlEditor, type SqlEditorHandle } from "./sql-editor";

const MOD =
	typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform)
		? "⌘"
		: "Ctrl";

const draftKey = (id: string) => `logistack.sql.${id}`;

function readDraft(id: string, schema: DatabaseSchema) {
	try {
		const saved = sessionStorage.getItem(draftKey(id));
		if (saved !== null) return saved;
	} catch {}
	const first =
		schema.schemas.find((s) => s.name === "public")?.tables[0] ??
		schema.schemas[0]?.tables[0];
	return first ? `select * from ${first.name} limit 100;\n` : "select 1;\n";
}

/** Seconds since `since`, ticking every 100 ms while it is set. */
function useElapsed(since: number | null) {
	const [now, setNow] = useState(() => performance.now());
	useEffect(() => {
		if (since === null) return;
		const t = setInterval(() => setNow(performance.now()), 100);
		return () => clearInterval(t);
	}, [since]);
	return since === null ? 0 : Math.max(0, now - since) / 1000;
}

type Running = { runId: string; since: number; cancelling: boolean };

/** The SQL tab: an editor over the results of its last run. */
export function SqlPanel({
	serviceId,
	schema,
	forbidden,
	onForbidden,
}: {
	serviceId: string;
	schema: DatabaseSchema;
	/** The api refused a write: the member has read only. */
	forbidden: boolean;
	onForbidden: () => void;
}) {
	const qc = useQueryClient();
	const editor = useRef<SqlEditorHandle>(null);
	const [text, setText] = useState(() => readDraft(serviceId, schema));
	const [readOnly, setReadOnly] = useState(true);
	const [running, setRunning] = useState<Running | null>(null);
	const [last, setLast] = useState<RunOutcome | null>(null);
	const [tab, setTab] = useState(0);
	const [failure, setFailure] = useState<string | null>(null);
	const elapsed = useElapsed(running?.since ?? null);
	const writes = !readOnly && !forbidden;

	useEffect(() => {
		try {
			sessionStorage.setItem(draftKey(serviceId), text);
		} catch {}
	}, [serviceId, text]);

	async function run(all: boolean) {
		if (running) return;
		const target = editor.current?.target(all);
		if (!target) return;
		const runId = crypto.randomUUID();
		editor.current?.markError(null);
		setFailure(null);
		setRunning({ runId, since: performance.now(), cancelling: false });
		try {
			const result = await databaseApi.query(serviceId, {
				sql: target.text,
				readOnly: !writes,
				runId,
			});
			setLast({ ...result, sql: target.text, readOnly: !writes });
			setTab(result.error ? result.results.length : 0);
			if (result.error?.position !== undefined)
				editor.current?.markError(target.offset + result.error.position);
			// A write may have changed rows or the schema itself.
			if (writes && !result.error)
				qc.invalidateQueries({ queryKey: ["database", serviceId] });
		} catch (e) {
			if (e instanceof ApiError && e.status === 403) {
				onForbidden();
				setReadOnly(true);
				setFailure(
					"You can read this database but not write to it. Read only is back on.",
				);
			} else setFailure(e instanceof Error ? e.message : "The run failed.");
		} finally {
			setRunning(null);
		}
	}

	function cancel() {
		if (!running || running.cancelling) return;
		setRunning({ ...running, cancelling: true });
		// A 404 means the run finished on its own first.
		databaseApi.cancel(serviceId, running.runId).catch(() => {});
	}

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2 sm:px-4">
				{running ? (
					<Button
						variant="outline"
						onClick={cancel}
						disabled={running.cancelling}
						className="min-w-24"
					>
						{running.cancelling ? (
							<Loader2 className="animate-spin" data-icon="inline-start" />
						) : (
							<Square className="fill-current" data-icon="inline-start" />
						)}
						{running.cancelling ? "Cancelling" : "Cancel"}
					</Button>
				) : (
					<Button onClick={() => run(false)} className="min-w-24">
						<Play className="fill-current" data-icon="inline-start" />
						Run
					</Button>
				)}
				<Button
					variant="ghost"
					onClick={() => run(true)}
					disabled={!!running}
					className="text-muted-foreground"
				>
					Run all
				</Button>
				<span
					className={cn(
						"text-xs text-muted-foreground tabular",
						running ? "t-swap" : "hidden sm:inline",
					)}
					aria-live="polite"
				>
					{running ? (
						`${elapsed.toFixed(1)} s`
					) : (
						<span className="flex items-center gap-2">
							<KbdGroup>
								<Kbd>{MOD}</Kbd>
								<Kbd>↵</Kbd>
							</KbdGroup>
							statement
							<KbdGroup className="ml-1">
								<Kbd>⇧</Kbd>
								<Kbd>{MOD}</Kbd>
								<Kbd>↵</Kbd>
							</KbdGroup>
							all
						</span>
					)}
				</span>
				<div
					className={cn(
						"ml-auto flex items-center gap-2 text-xs font-medium",
						forbidden && "text-muted-foreground",
					)}
					title={
						forbidden ? "You have read access to this service only." : undefined
					}
				>
					<label htmlFor="sql-read-only" className="cursor-pointer">
						{writes ? (
							<span className="t-swap flex items-center gap-1.5 text-warn-text">
								<span className="size-1.5 rounded-full bg-warn" aria-hidden />
								Writes commit
							</span>
						) : (
							<span>{forbidden ? "Read only access" : "Read only"}</span>
						)}
					</label>
					<Switch
						id="sql-read-only"
						aria-label="Read only"
						checked={!writes}
						disabled={forbidden || !!running}
						onCheckedChange={(on) => setReadOnly(on)}
					/>
				</div>
			</div>
			<SqlEditor
				ref={editor}
				value={text}
				onChange={setText}
				schema={schema}
				onRun={run}
				writes={writes}
				className="h-[38%] min-h-36 shrink-0 border-b"
			/>
			{failure ? (
				<p
					role="alert"
					className="t-reveal px-4 py-5 text-sm text-bad-text sm:px-5"
				>
					{failure}
				</p>
			) : last ? (
				<div
					className={cn(
						"flex min-h-0 flex-1 flex-col transition-opacity duration-(--duration-quick)",
						running && "opacity-60",
					)}
					aria-busy={!!running || undefined}
				>
					<ResultTabs run={last} tab={tab} onTab={setTab} />
				</div>
			) : (
				<div className="grid flex-1 place-items-center px-6 text-center">
					<p className="max-w-[44ch] text-sm text-muted-foreground">
						{running
							? "Running…"
							: "Results appear here. Runs are one transaction, stop after 30 seconds and return up to 1,000 rows per statement."}
					</p>
				</div>
			)}
		</div>
	);
}
