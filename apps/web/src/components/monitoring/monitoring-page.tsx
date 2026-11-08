import { Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Page, PageHeader } from "@/components/page-header";
import { SlidingTabs } from "@/components/sliding-tabs";
import { Button } from "@/components/ui/button";

type Section = "overview" | "traffic" | "usage" | "nodes" | "alerts";

const TO = {
	overview: "/monitoring",
	traffic: "/monitoring/traffic",
	usage: "/monitoring/usage",
	nodes: "/monitoring/nodes",
	alerts: "/monitoring/alerts",
} as const;

/** Title, the Add server action and the section tabs shared by the three Monitoring pages. */
export function MonitoringPage({
	section,
	children,
}: {
	section: Section;
	children: ReactNode;
}) {
	const navigate = useNavigate();
	return (
		<Page className="max-w-7xl">
			<PageHeader
				title="Monitoring"
				description="CPU, memory, disk and network for every node, sampled every 10 seconds."
				actions={
					<Button asChild>
						<Link to="/monitoring/nodes/new">
							<Plus data-icon="inline-start" />
							Add server
						</Link>
					</Button>
				}
				className="pb-4"
			/>
			<div className="mb-6 border-b">
				<SlidingTabs
					idPrefix="monitoring"
					label="Monitoring sections"
					value={section}
					onChange={(id) => navigate({ to: TO[id], search: (s) => s })}
					items={[
						{ id: "overview", label: "Overview" },
						{ id: "traffic", label: "Traffic" },
						{ id: "usage", label: "Usage" },
						{ id: "nodes", label: "Nodes" },
						{ id: "alerts", label: "Settings" },
					]}
				/>
			</div>
			<div
				id="monitoring-panel"
				role="tabpanel"
				aria-labelledby={`monitoring-tab-${section}`}
			>
				{children}
			</div>
		</Page>
	);
}
