import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { CommandMenuProvider } from "@/components/shell/command-menu";
import { SponsorGlow } from "@/components/shell/sponsor-card";
import { TopBar } from "@/components/shell/top-bar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useSurfaces, WorkSidebar } from "@/components/work/shell/work-nav";
import { WorkShortcuts } from "@/components/work/shortcuts";
import { TaskSheetHost } from "@/components/work/task-sheet/task-sheet";
import { meQuery } from "@/lib/api/access";
import { instanceStatusQuery } from "@/lib/api/instance";
import { useLiveHostSamples } from "@/lib/api/monitoring";
import { useOrgEventRefresh } from "@/lib/api/org-events";
import { auth } from "@/lib/auth";
import { useDocumentBranding } from "@/lib/document-branding";
import { ENROL_PATH, shouldEnrol } from "@/lib/two-factor-gate";

/** Paths a Work-only actor may open; anything else redirects to `/work` (section 3). */
const WORK_ONLY_PATHS = /^\/(work|account)(\/|$)/;

export const Route = createFileRoute("/_app")({
	/** `?task=tsk_…` opens the task sheet over any page. */
	validateSearch: z.object({
		task: z.string().startsWith("tsk_").optional().catch(undefined),
	}),
	beforeLoad: async ({ context, location }) => {
		const status =
			await context.queryClient.ensureQueryData(instanceStatusQuery);
		if (!status.setupCompleted) throw redirect({ to: "/setup" });
		const user = await auth.getSession();
		if (!user) {
			throw redirect({ to: "/sign-in", search: { redirect: location.href } });
		}
		const me = await context.queryClient
			.ensureQueryData(meQuery)
			.catch(() => undefined);
		if (me && shouldEnrol(me, location.pathname))
			throw redirect({ to: ENROL_PATH });
		const surfaces = (me as { surfaces?: string[] } | undefined)?.surfaces;
		if (
			surfaces?.includes("work") &&
			!surfaces.includes("ops") &&
			!WORK_ONLY_PATHS.test(location.pathname)
		)
			throw redirect({ to: "/work", replace: true });
		return { user };
	},
	component: AppLayout,
});

function AppLayout() {
	useLiveHostSamples();
	useOrgEventRefresh();
	useDocumentBranding();
	const { workOnly, work } = useSurfaces();
	return (
		<SidebarProvider>
			<CommandMenuProvider>
				{workOnly ? <WorkSidebar /> : <AppSidebar />}
				<SidebarInset className="min-w-0">
					<TopBar />
					<Outlet />
				</SidebarInset>
				{work && <TaskSheetHost />}
				{work && <WorkShortcuts />}
				<SponsorGlow />
			</CommandMenuProvider>
		</SidebarProvider>
	);
}
