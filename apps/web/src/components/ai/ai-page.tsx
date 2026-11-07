import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LockKeyhole, Plus, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { SlidingTabs } from "@/components/sliding-tabs";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { aiSettingsQuery } from "@/lib/api/ai";

export type Section = "overview" | "providers" | "gateway" | "budgets";

const TO = {
	overview: "/ai",
	providers: "/ai/providers",
	gateway: "/ai/gateway",
	budgets: "/ai/budgets",
} as const;

const ADMIN_ONLY: Section[] = ["providers", "budgets"];

/** The AI settings inside a tab; the layout renders tabs only once they loaded. */
export const useAiSettings = () => useSuspenseQuery(aiSettingsQuery).data;

/**
 * Title, tabs and access handling around the AI tabs. It lives in the layout route, so the
 * tab list stays mounted (and keeps keyboard focus) while the tabs change.
 */
export function AiPage({
	section,
	actions,
	children,
}: {
	section: Section;
	actions?: ReactNode;
	children: ReactNode;
}) {
	const navigate = useNavigate();
	const { data: settings, error } = useQuery(aiSettingsQuery);
	const forbidden = error instanceof ApiError && error.status === 403;
	const admin = settings?.canAdmin ?? false;
	const items = [
		{ id: "overview" as const, label: "Overview" },
		...(admin ? [{ id: "providers" as const, label: "Providers" }] : []),
		{ id: "gateway" as const, label: "Gateway" },
		...(admin ? [{ id: "budgets" as const, label: "Budgets" }] : []),
	];

	return (
		<Page className="max-w-7xl">
			<PageHeader
				title="AI"
				description="One OpenAI- and Anthropic-compatible endpoint in front of free and paid model providers. Free models go first; paid ones count against each member's monthly budget."
				actions={!forbidden && actions}
				className="pb-4"
			/>
			{forbidden ? (
				<EmptyState
					icon={LockKeyhole}
					title="Your role doesn't include AI"
					description="The AI gateway is open to owners and admins, and to anyone whose role grants the AI permission. Ask an admin to add it to your role."
				/>
			) : error ? (
				<EmptyState
					icon={LockKeyhole}
					title="Couldn't load the AI settings"
					description={error.message}
				/>
			) : (
				<>
					<div className="mb-6 border-b">
						<SlidingTabs
							idPrefix="ai"
							label="AI sections"
							value={section}
							onChange={(id) => navigate({ to: TO[id] })}
							items={items}
						/>
					</div>
					<div
						id="ai-panel"
						role="tabpanel"
						aria-labelledby={`ai-tab-${section}`}
					>
						{!settings ? (
							<div className="grid gap-4" aria-hidden>
								<div className="t-skel h-24 rounded-xl bg-muted-foreground/8" />
								<div className="t-skel h-64 rounded-xl bg-muted-foreground/8" />
							</div>
						) : ADMIN_ONLY.includes(section) && !admin ? (
							<EmptyState
								icon={ShieldCheck}
								title="Only admins manage this"
								description="Providers and budgets are set by the organization's owners and admins. You can still create your own gateway keys."
							>
								<Button asChild variant="outline">
									<Link to="/ai/gateway">Open Gateway</Link>
								</Button>
							</EmptyState>
						) : (
							children
						)}
					</div>
				</>
			)}
		</Page>
	);
}

export function AddProviderButton({ variant }: { variant?: "outline" }) {
	return (
		<Button asChild variant={variant}>
			<Link to="/ai/providers/new">
				<Plus data-icon="inline-start" />
				Add provider
			</Link>
		</Button>
	);
}
