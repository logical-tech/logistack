import type { ReactNode } from "react";
import {
	ACTOR_KIND,
	absoluteTime,
	actorName,
	OutcomeLabel,
} from "@/components/access/audit-parts";
import { CopyButton } from "@/components/access/copy-button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import type { AuditEntry } from "@/lib/api/access-types";
import { relativeTime } from "@/lib/format";

const json = (v: unknown) => JSON.stringify(v, null, 2);

function Code({ label, value }: { label: string; value: unknown }) {
	return (
		<div className="grid min-w-0 content-start gap-1.5">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<pre className="max-h-80 overflow-auto rounded-lg whitespace-pre-wrap [overflow-wrap:anywhere] bg-muted/60 p-3 font-mono text-xs leading-relaxed dark:bg-muted/40">
				{json(value)}
			</pre>
		</div>
	);
}

/** Before and after side by side when the row has them; otherwise the whole document. */
function Diff({ diff }: { diff: unknown }) {
	if (diff === null || diff === undefined)
		return (
			<p className="text-sm text-muted-foreground">No details recorded.</p>
		);
	const d = diff as Record<string, unknown>;
	if (typeof diff === "object" && ("before" in d || "after" in d))
		return (
			<div className="grid gap-3 sm:grid-cols-2">
				<Code label="Before" value={d.before ?? null} />
				<Code label="After" value={d.after ?? null} />
			</div>
		);
	if (typeof diff === "object" && "input" in d && Object.keys(d).length === 1)
		return <Code label="Request" value={d.input} />;
	return <Code label="Details" value={diff} />;
}

function Item({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="contents">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-words">{children}</dd>
		</div>
	);
}

const mono = (v: string | null) =>
	v ? (
		<span className="inline-flex max-w-full items-center gap-1">
			<span className="truncate font-mono text-xs">{v}</span>
			<CopyButton value={v} label="value" className="-my-1" />
		</span>
	) : (
		<span className="text-muted-foreground">None</span>
	);

export function AuditDrawer({
	entry,
	onOpenChange,
}: {
	entry: AuditEntry | null;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Sheet open={entry !== null} onOpenChange={onOpenChange}>
			<SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-xl">
				{entry && (
					<>
						<SheetHeader className="border-b p-5 pr-12">
							<SheetTitle className="font-mono text-base">
								{entry.action}
							</SheetTitle>
							<SheetDescription>
								{actorName(entry)} · {relativeTime(entry.at)}
							</SheetDescription>
						</SheetHeader>
						<div className="grid gap-6 p-5">
							<dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
								<Item label="Outcome">
									<OutcomeLabel outcome={entry.outcome} />
								</Item>
								<Item label="When">
									<time dateTime={entry.at} className="tabular">
										{absoluteTime(entry.at)}
									</time>
								</Item>
								<Item label="Actor">
									{actorName(entry)}
									<span className="text-muted-foreground">
										{" "}
										· {ACTOR_KIND[entry.actorKind]}
									</span>
								</Item>
								<Item label="Actor id">{mono(entry.actorId)}</Item>
								<Item label="Resource">{entry.resourceType}</Item>
								<Item label="Resource id">{mono(entry.resourceId)}</Item>
								<Item label="IP">{mono(entry.ip)}</Item>
								<Item label="User agent">
									<span className="text-xs text-muted-foreground">
										{entry.userAgent ?? "None"}
									</span>
								</Item>
								<Item label="Request id">{mono(entry.requestId)}</Item>
							</dl>
							<section aria-labelledby="audit-diff" className="grid gap-3">
								<div>
									<h3 id="audit-diff" className="text-sm font-semibold">
										Changes
									</h3>
									<p className="text-xs text-muted-foreground">
										Secrets are redacted before the row is written.
									</p>
								</div>
								<Diff diff={entry.diff} />
							</section>
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}
