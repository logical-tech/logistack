import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	notFound,
	Outlet,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { Page } from "@/components/page-header";
import { SlidingTabs } from "@/components/sliding-tabs";
import { GitSyncError } from "@/components/stack/git-sync-error";
import { StackHeader } from "@/components/stack/stack-header";
import { ApiError } from "@/lib/api";
import { type StackId, stackQuery } from "@/lib/api/stacks";

const BASE = "/projects/$projectId/stacks/$stackId";

/** Tabs are child routes; the id is the path segment after the stack. */
const TABS = [
	{ id: "overview", label: "Overview", to: BASE },
	{ id: "logs", label: "Logs", to: `${BASE}/logs` },
	{ id: "compose", label: "Compose", to: `${BASE}/compose` },
] as const;

type TabId = (typeof TABS)[number]["id"];

export const Route = createFileRoute(
	"/_app/projects/$projectId/stacks/$stackId",
)({
	params: {
		parse: ({ stackId }) => {
			if (!stackId.startsWith("stk_")) throw notFound();
			return { stackId: stackId as StackId };
		},
		stringify: ({ stackId }) => ({ stackId }),
	},
	loader: async ({ context, params }) => {
		try {
			const stack = await context.queryClient.ensureQueryData(
				stackQuery(params.stackId),
			);
			return { crumb: stack.name };
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
	component: StackLayout,
});

function StackLayout() {
	const { projectId, stackId } = Route.useParams();
	const navigate = useNavigate();
	const { data: stack } = useQuery(stackQuery(stackId));
	const tab = useRouterState({
		select: (s) =>
			(s.matches.at(-1)?.routeId.split("$stackId/")[1] || "overview") as TabId,
	});
	if (!stack) return null;

	return (
		<Page className="max-w-6xl">
			<StackHeader stack={stack} projectId={projectId} />
			{stack.gitSyncError && <GitSyncError error={stack.gitSyncError} />}
			<div className="mb-6 border-b">
				<SlidingTabs
					label="Stack sections"
					idPrefix="stack"
					value={tab}
					onChange={(id) => {
						const to = TABS.find((t) => t.id === id)?.to ?? BASE;
						navigate({ to, params: { projectId, stackId } });
					}}
					items={TABS.map((t) => ({ id: t.id, label: t.label }))}
				/>
			</div>
			<div
				id="stack-panel"
				role="tabpanel"
				aria-labelledby={`stack-tab-${tab}`}
			>
				<Outlet />
			</div>
		</Page>
	);
}
