import { Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Page, PageHeader } from "@/components/page-header";
import { SlidingTabs } from "@/components/sliding-tabs";
import { Button } from "@/components/ui/button";

type Section =
	| "overview"
	| "traffic"
	| "usage"
	| "nodes"
	| "uptime"
	| "incidents"
	| "status-pages"
	| "patches"
	| "alerts";

const TO = {
	overview: "/monitoring",
	traffic: "/monitoring/traffic",
	usage: "/monitoring/usage",
	nodes: "/monitoring/nodes",
	uptime: "/monitoring/uptime",
	incidents: "/monitoring/incidents",
	"status-pages": "/monitoring/status-pages",
	patches: "/monitoring/patches",
	alerts: "/monitoring/alerts",
} as const;

/** Title, the primary action and the section tabs shared by the Monitoring pages. */
export function MonitoringPage({
	section,
	children,
	description = "CPU, memory, disk and network for every node, sampled every 10 seconds.",
	action,
}: {
	section: Section;
	children: ReactNode;
	description?: string;
	/** Replaces Add server, for sections whose main action is something else. */
	action?: ReactNode;
}) {
	const navigate = useNavigate();
	return (
		<Page className="max-w-7xl">
			<PageHeader
				title="Monitoring"
				description={description}
				actions={
					action ?? (
						<Button asChild>
							<Link to="/monitoring/nodes/new">
								<Plus data-icon="inline-start" />
								Add server
							</Link>
						</Button>
					)
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
						{ id: "uptime", label: "Uptime" },
						{ id: "incidents", label: "Incidents" },
						{ id: "status-pages", label: "Status pages" },
						{ id: "patches", label: "OS updates" },
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
