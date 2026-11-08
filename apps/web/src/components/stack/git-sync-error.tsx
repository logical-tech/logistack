import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { StackDetail } from "@/lib/api/stacks";
import { relativeTime } from "@/lib/format";

/** Why the last push did not change a git stack; the stack keeps running what it had. */
export function GitSyncError({
	error,
}: {
	error: NonNullable<StackDetail["gitSyncError"]>;
}) {
	return (
		<Alert className="mb-6">
			<CircleAlert className="text-warn-text!" aria-hidden />
			<AlertTitle>
				The last push was not applied
				{error.commitSha && (
					<>
						{" "}
						(<span className="font-mono">{error.commitSha.slice(0, 7)}</span>)
					</>
				)}
			</AlertTitle>
			<AlertDescription>
				<div className="text-pretty">{error.message}</div>
				{error.details.length > 0 && (
					<ul className="mt-1 list-disc space-y-0.5 pl-4">
						{error.details.map((d) => (
							<li key={d} className="font-mono text-xs">
								{d}
							</li>
						))}
					</ul>
				)}
				<p className="mt-2 text-xs text-pretty">
					Pushed{" "}
					<time dateTime={error.at} title={new Date(error.at).toLocaleString()}>
						{relativeTime(error.at)}
					</time>
					. The stack still runs the previous compose file; push a fix or sync
					it again.
				</p>
			</AlertDescription>
		</Alert>
	);
}
