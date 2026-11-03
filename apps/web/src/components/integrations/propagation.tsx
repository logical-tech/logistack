import { useQuery } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { StatusDot } from "@/components/status";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const RESOLVERS: Record<string, string> = {
	cloudflare: "Cloudflare 1.1.1.1",
	google: "Google 8.8.8.8",
};

/**
 * Asks each public resolver every two seconds until all of them return the record, then
 * stops. Each resolver's row flips on its own, so slow caches are visible as they catch up.
 */
export function LivePropagation({
	serviceId,
	hostname,
	type,
	content,
	startedAt,
}: {
	serviceId: string;
	hostname: string;
	type: "A" | "AAAA" | "CNAME";
	content: string;
	startedAt: number;
}) {
	const q = useQuery({
		queryKey: ["dns-propagation", serviceId, hostname, type, content],
		queryFn: () =>
			api.networking.dns.propagation(serviceId, { hostname, type, content }),
		refetchInterval: (query) => (query.state.data?.ok ? false : 2_000),
		enabled: Boolean(hostname && content),
	});
	const done = q.data?.ok ?? false;
	const now = useNow(1000, !done);
	const resolvers = q.data?.resolvers ?? [
		{ name: "cloudflare", ok: false },
		{ name: "google", ok: false },
	];
	return (
		<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
			<div className="flex items-center justify-between gap-3 px-4 py-3">
				<div className="flex min-w-0 items-center gap-2.5" aria-live="polite">
					{done ? (
						<CircleCheck className="t-reveal size-5 text-ok-text" aria-hidden />
					) : (
						<StatusDot meta={{ label: "", tone: "busy", live: true }} />
					)}
					<p className="text-sm font-medium">
						{done
							? "Visible everywhere we checked"
							: `Checking ${resolvers.filter((r) => r.ok).length} of ${resolvers.length} resolvers`}
					</p>
				</div>
				{!done && (
					<span className="tabular text-xs text-muted-foreground">
						{formatDuration((now - startedAt) / 1000)}
					</span>
				)}
			</div>
			<ul className="divide-y border-t">
				{resolvers.map((r) => (
					<li
						key={r.name}
						className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
					>
						<span className="flex items-center gap-2.5">
							<StatusDot
								meta={{
									label: "",
									tone: r.ok ? "ok" : "busy",
									live: !r.ok,
								}}
							/>
							{RESOLVERS[r.name] ?? r.name}
						</span>
						<span
							key={String(r.ok)}
							className={cn(
								"t-swap font-mono text-xs",
								r.ok ? "text-foreground" : "text-muted-foreground",
							)}
						>
							{r.ok ? `${type} ${content}` : "not yet"}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}
