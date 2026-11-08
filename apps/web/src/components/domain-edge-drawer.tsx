import { type DomainEdge, IpRange } from "@logistack/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/api/client";
import { ok } from "@/lib/api/http";
import type { DomainListItem } from "@/lib/api/networking";

export const edgeQuery = (id: string) => ({
	queryKey: ["domain-edge", id],
	queryFn: () => ok(client.api.domains[":id"].edge.$get({ param: { id } })),
});

const lines = (text: string) =>
	text
		.split(/\n/)
		.map((s) => s.trim())
		.filter(Boolean);
const words = (text: string) => text.split(/[\s,]+/).filter(Boolean);

type Draft = {
	limit: boolean;
	rps: string;
	burst: string;
	exempt: string;
	block: boolean;
	paths: string;
	agents: string;
	custom: boolean;
	page: string;
};

function draftOf(e: DomainEdge): Draft {
	return {
		limit: e.rateLimit !== null,
		rps: String(e.rateLimit?.requestsPerSecond ?? 10),
		burst: String(e.rateLimit?.burst ?? 20),
		exempt: (e.rateLimit?.exemptCidrs ?? []).join("\n"),
		block: e.block !== null,
		paths: (e.block?.paths ?? []).join("\n"),
		agents: (e.block?.userAgents ?? []).join("\n"),
		custom: e.errorPage !== null,
		page: e.errorPage ?? "",
	};
}

/** The draft as the API body, or the first problem to show. */
function parse(d: Draft): DomainEdge | string {
	let rateLimit: DomainEdge["rateLimit"] = null;
	if (d.limit) {
		const rps = Number(d.rps);
		const burst = Number(d.burst);
		if (!Number.isInteger(rps) || rps < 1 || rps > 10_000)
			return "Requests per second must be a whole number from 1 to 10,000.";
		if (!Number.isInteger(burst) || burst < rps || burst > 100_000)
			return "Burst must be a whole number, at least the requests per second.";
		const exemptCidrs = words(d.exempt);
		const bad = exemptCidrs.find((c) => !IpRange.safeParse(c).success);
		if (bad) return `${bad} is not an IP address or CIDR range.`;
		rateLimit = { requestsPerSecond: rps, burst, exemptCidrs };
	}
	let block: DomainEdge["block"] = null;
	if (d.block) {
		const paths = lines(d.paths);
		const userAgents = lines(d.agents);
		const bad = paths.find((p) => !/^\/\S*$/.test(p));
		if (bad) return `${bad} must start with / and have no spaces.`;
		if (userAgents.some((u) => u.length < 2))
			return "User-agent fragments need at least 2 characters.";
		if (!paths.length && !userAgents.length)
			return "Add a path or a user agent to block, or turn blocking off.";
		block = { paths, userAgents };
	}
	if (d.custom && !d.page.trim())
		return "Paste the HTML of your error page, or use the branded page.";
	if (d.page.length > 65_536) return "The error page is over 64 KB.";
	return { rateLimit, block, errorPage: d.custom ? d.page : null };
}

/** Rate limit, block rules and the 502-504 page of one domain. */
export function DomainEdgeDrawer({
	domain,
	onOpenChange,
}: {
	domain: DomainListItem | null;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Sheet open={domain !== null} onOpenChange={onOpenChange}>
			<SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-lg">
				{domain && <Body key={domain.id} domain={domain} />}
			</SheetContent>
		</Sheet>
	);
}

function Section({
	title,
	description,
	toggle,
	children,
}: {
	title: string;
	description: string;
	toggle?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<section className="grid gap-4 border-b p-5 last:border-b-0">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h3 className="text-sm font-medium">{title}</h3>
					<p className="mt-1 max-w-[52ch] text-sm text-pretty text-muted-foreground">
						{description}
					</p>
				</div>
				{toggle}
			</div>
			{children}
		</section>
	);
}

function Body({ domain }: { domain: DomainListItem }) {
	const qc = useQueryClient();
	const uid = useId();
	const { data, error } = useQuery(edgeQuery(domain.id));
	const [draft, setDraft] = useState<Draft | null>(null);
	useEffect(() => {
		if (data) setDraft(draftOf(data));
	}, [data]);
	const save = useMutation({
		mutationFn: (json: DomainEdge) =>
			ok(
				client.api.domains[":id"].edge.$put({ param: { id: domain.id }, json }),
			),
		onSuccess: (r) => {
			qc.setQueryData(edgeQuery(domain.id).queryKey, r);
			qc.invalidateQueries({ queryKey: ["domains"] });
			toast.success("Traffic rules saved", {
				description: "The proxy applies them within a few seconds.",
			});
		},
		onError: (e) => toast.error(e.message),
	});
	const set = (patch: Partial<Draft>) =>
		setDraft((d) => (d ? { ...d, ...patch } : d));
	const result = draft && parse(draft);
	const problem = typeof result === "string" ? result : null;

	const header = (
		<SheetHeader className="border-b p-5 pr-12">
			<SheetTitle className="text-base">Traffic rules</SheetTitle>
			<SheetDescription className="font-mono text-xs">
				{domain.hostname}
				{domain.pathPrefix}
			</SheetDescription>
		</SheetHeader>
	);
	if (domain.redirectTo)
		return (
			<>
				{header}
				<p className="p-5 text-sm text-muted-foreground">
					This domain redirects to {domain.redirectTo} before any rule runs. Set
					the rules on that domain instead.
				</p>
			</>
		);
	if (!draft)
		return (
			<>
				{header}
				{error ? (
					<p className="p-5 text-sm text-bad-text" role="alert">
						Could not load the rules: {error.message}
					</p>
				) : (
					<div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Loading rules…
					</div>
				)}
			</>
		);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (result && typeof result !== "string") save.mutate(result);
			}}
		>
			{header}
			<Section
				title="Rate limit"
				description={
					domain.tunnel
						? "Not available through a Cloudflare Tunnel: every request comes from cloudflared, so a per-address limit would hold back every visitor at once."
						: "Caps how fast one IP address can send requests. Above the limit the proxy answers 429 Too Many Requests."
				}
				toggle={
					<Switch
						checked={draft.limit}
						disabled={domain.tunnel}
						aria-label="Limit requests per IP address"
						onCheckedChange={(limit) => set({ limit })}
					/>
				}
			>
				{draft.limit && (
					<>
						<div className="grid grid-cols-2 gap-3">
							<Field
								id={`${uid}-rps`}
								label="Requests per second"
								hint="Average, per IP."
							>
								<Input
									id={`${uid}-rps`}
									inputMode="numeric"
									value={draft.rps}
									onChange={(e) => set({ rps: e.target.value })}
									className="tabular-nums"
								/>
							</Field>
							<Field
								id={`${uid}-burst`}
								label="Burst"
								hint="Allowed at once, such as a page load."
							>
								<Input
									id={`${uid}-burst`}
									inputMode="numeric"
									value={draft.burst}
									onChange={(e) => set({ burst: e.target.value })}
									className="tabular-nums"
								/>
							</Field>
						</div>
						<Field
							id={`${uid}-exempt`}
							label="Exempt addresses"
							optional
							hint="One per line: your office, a monitoring service, another of your servers."
						>
							<Textarea
								id={`${uid}-exempt`}
								value={draft.exempt}
								onChange={(e) => set({ exempt: e.target.value })}
								placeholder="203.0.113.0/24"
								className="font-mono text-sm"
								spellCheck={false}
							/>
						</Field>
					</>
				)}
			</Section>
			<Section
				title="Block requests"
				description="Answers 403 to scanners and bots before they reach the service. Runs before the rate limit."
				toggle={
					<Switch
						checked={draft.block}
						aria-label="Block paths and user agents"
						onCheckedChange={(block) => set({ block })}
					/>
				}
			>
				{draft.block && (
					<>
						<Field
							id={`${uid}-paths`}
							label="Paths"
							hint="One per line, case-insensitive. * matches anything: /wp-admin* blocks /wp-admin and everything under it."
						>
							<Textarea
								id={`${uid}-paths`}
								value={draft.paths}
								onChange={(e) => set({ paths: e.target.value })}
								placeholder={"/wp-admin*\n/.env"}
								className="font-mono text-sm"
								spellCheck={false}
							/>
						</Field>
						<Field
							id={`${uid}-agents`}
							label="User agents"
							hint="One per line. A request whose User-Agent contains the text, in any case, is blocked."
						>
							<Textarea
								id={`${uid}-agents`}
								value={draft.agents}
								onChange={(e) => set({ agents: e.target.value })}
								placeholder={"sqlmap\nzgrab"}
								className="font-mono text-sm"
								spellCheck={false}
							/>
						</Field>
					</>
				)}
			</Section>
			<Section
				title="Custom error page"
				description="Shown with a 502, 503 or 504 when the proxy cannot reach the service, such as during a failed deploy. Off, visitors see a page with your organization's name and logo."
				toggle={
					<Switch
						checked={draft.custom}
						aria-label="Use my own error page"
						onCheckedChange={(custom) => set({ custom })}
					/>
				}
			>
				{draft.custom && (
					<Field
						id={`${uid}-page`}
						label="HTML"
						hint="A complete page of at most 64 KB. Inline styles and images: the service is down, so it cannot serve them."
					>
						<Textarea
							id={`${uid}-page`}
							value={draft.page}
							onChange={(e) => set({ page: e.target.value })}
							placeholder="<!doctype html>…"
							className="min-h-40 font-mono text-xs"
							spellCheck={false}
						/>
					</Field>
				)}
			</Section>
			<div className="sticky bottom-0 flex items-center justify-between gap-4 border-t bg-background p-5">
				<p className="text-sm text-bad-text" aria-live="polite">
					{problem}
				</p>
				<Button type="submit" disabled={Boolean(problem) || save.isPending}>
					{save.isPending && <Loader2 className="animate-spin" />}
					Save
				</Button>
			</div>
		</form>
	);
}
