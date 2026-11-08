import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	notFound,
	Outlet,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { Page } from "@/components/page-header";
import { ServiceHeader } from "@/components/service/service-header";
import { SlidingTabs } from "@/components/sliding-tabs";
import { ApiError } from "@/lib/api";
import { pluginContributionsQuery } from "@/lib/api/plugins";
import { overviewQuery } from "@/lib/api/service-ops";
import type { ServiceId } from "@/lib/api/types";

const BASE = "/projects/$projectId/services/$serviceId";

/** Tabs are child routes; the id is the path segment after the service. */
const TABS = [
	{ id: "overview", label: "Overview", to: BASE },
	{ id: "game", label: "Game", to: `${BASE}/game` },
	{ id: "storage", label: "Storage", to: `${BASE}/storage` },
	{ id: "database", label: "Database", to: `${BASE}/database` },
	{ id: "operations", label: "Operations", to: `${BASE}/operations` },
	{ id: "files", label: "Files", to: `${BASE}/files` },
	{ id: "deployments", label: "Deployments", to: `${BASE}/deployments` },
	{ id: "logs", label: "Logs", to: `${BASE}/logs` },
	{ id: "terminal", label: "Terminal", to: `${BASE}/terminal` },
	{ id: "environment", label: "Environment", to: `${BASE}/environment` },
	{ id: "domains", label: "Domains", to: `${BASE}/domains` },
	{ id: "metrics", label: "Metrics", to: `${BASE}/metrics` },
	{ id: "analytics", label: "Analytics", to: `${BASE}/analytics` },
	{ id: "backups", label: "Backups", to: `${BASE}/backups` },
	{ id: "security", label: "Security", to: `${BASE}/security` },
	{ id: "settings", label: "Settings", to: `${BASE}/settings` },
] as const;

type TabId = (typeof TABS)[number]["id"];

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId",
)({
	params: {
		parse: ({ serviceId }) => {
			if (!serviceId.startsWith("svc_")) throw notFound();
			return { serviceId: serviceId as ServiceId };
		},
		stringify: ({ serviceId }) => ({ serviceId }),
	},
	loader: async ({ context, params }) => {
		try {
			const service = await context.queryClient.ensureQueryData(
				overviewQuery(params.serviceId),
			);
			return { crumb: service.name };
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
	component: ServiceLayout,
});

function ServiceLayout() {
	const { projectId, serviceId } = Route.useParams();
	const navigate = useNavigate();
	const { data: service } = useQuery(overviewQuery(serviceId));
	const { data: contributions } = useQuery(pluginContributionsQuery);
	const tab = useRouterState({
		select: (s) => {
			const leaf = s.matches.at(-1);
			const sub = leaf?.routeId.split("$serviceId/")[1];
			// Plugin tabs are one route; each install's page is its own tab.
			if (sub?.startsWith("plugin/") && leaf) {
				const p = leaf.params as { installId?: string; pageId?: string };
				return `plugin:${p.installId}:${p.pageId}`;
			}
			return (sub || "overview") as TabId;
		},
	});
	if (!service) return null;
	const pluginTabs = (contributions ?? []).flatMap((c) =>
		c.pages
			.filter(
				(p) =>
					p.location === "service-tab" &&
					(!p.serviceKinds?.length || p.serviceKinds.includes(service.kind)),
			)
			.map((p) => ({
				id: `plugin:${c.installId}:${p.id}`,
				label: p.title,
				installId: c.installId,
				pageId: p.id,
			})),
	);

	return (
		<Page className="max-w-6xl">
			<ServiceHeader service={service} projectId={projectId} />
			<div className="mb-6 border-b">
				<SlidingTabs
					label="Service sections"
					idPrefix="service"
					value={tab}
					onChange={(id) => {
						const plugin = pluginTabs.find((t) => t.id === id);
						if (plugin) {
							navigate({
								to: "/projects/$projectId/services/$serviceId/plugin/$installId/$pageId/$",
								params: {
									projectId,
									serviceId,
									installId: plugin.installId,
									pageId: plugin.pageId,
									_splat: "",
								},
							});
							return;
						}
						const to = TABS.find((t) => t.id === id)?.to ?? BASE;
						navigate({ to, params: { projectId, serviceId } });
					}}
					items={TABS.filter(
						(t) =>
							(t.id !== "storage" || service.kind === "storage") &&
							(t.id !== "database" || service.kind === "database") &&
							(t.id !== "operations" || service.kind === "database") &&
							(t.id !== "game" || service.kind === "game") &&
							// Game traffic is not HTTP: Caddy domains don't reach it.
							(t.id !== "domains" || service.kind !== "game") &&
							(t.id !== "analytics" || service.kind !== "game"),
					)
						.map((t): { id: string; label: string } => ({
							id: t.id,
							label: t.label,
						}))
						.concat(pluginTabs.map((t) => ({ id: t.id, label: t.label })))}
				/>
			</div>
			<div
				id="service-panel"
				role="tabpanel"
				aria-labelledby={`service-tab-${tab}`}
			>
				<Outlet />
			</div>
		</Page>
	);
}
