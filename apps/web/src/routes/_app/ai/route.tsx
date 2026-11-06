import {
	createFileRoute,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import {
	AddProviderButton,
	AiPage,
	type Section,
} from "@/components/ai/ai-page";

export const Route = createFileRoute("/_app/ai")({
	staticData: { crumb: "AI" },
	component: AiLayout,
});

function AiLayout() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const tab = pathname.replace(/^\/ai\/?/, "").replace(/\/$/, "");
	// The add-provider wizard is a page of its own, without the tabs.
	if (tab.includes("/")) return <Outlet />;
	const section = (tab || "overview") as Section;
	return (
		<AiPage
			section={section}
			actions={section === "providers" ? <AddProviderButton /> : undefined}
		>
			<Outlet />
		</AiPage>
	);
}
