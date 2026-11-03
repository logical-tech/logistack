import type { AuditEntry } from "@/lib/api/access-types";
import type { Tone } from "@/lib/status";
import { TONE_DOT, TONE_TEXT } from "@/lib/status";
import { cn } from "@/lib/utils";

export const OUTCOME: Record<
	AuditEntry["outcome"],
	{ label: string; tone: Tone }
> = {
	success: { label: "Success", tone: "ok" },
	denied: { label: "Denied", tone: "warn" },
	error: { label: "Error", tone: "bad" },
};

export const ACTOR_KIND: Record<AuditEntry["actorKind"], string> = {
	user: "Person",
	apikey: "API key",
	machine: "Service account",
	system: "System",
};

export function OutcomeLabel({ outcome }: { outcome: AuditEntry["outcome"] }) {
	const o = OUTCOME[outcome];
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 text-sm font-medium",
				TONE_TEXT[o.tone],
			)}
		>
			<span
				aria-hidden
				className={cn("size-2 rounded-full", TONE_DOT[o.tone])}
			/>
			{o.label}
		</span>
	);
}

/** Deleted users and keys keep their id. */
export const actorName = (e: Pick<AuditEntry, "actorName" | "actorId">) =>
	e.actorName ?? e.actorId;

export const absoluteTime = (iso: string) =>
	new Intl.DateTimeFormat("en", {
		dateStyle: "medium",
		timeStyle: "medium",
	}).format(new Date(iso));
