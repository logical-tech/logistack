import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { CommandMenuProvider } from "@/components/shell/command-menu";
import { TopBar } from "@/components/shell/top-bar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { meQuery } from "@/lib/api/access";
import { instanceStatusQuery } from "@/lib/api/instance";
import { useLiveHostSamples } from "@/lib/api/monitoring";
import { auth } from "@/lib/auth";
import { ENROL_PATH, shouldEnrol } from "@/lib/two-factor-gate";

export const Route = createFileRoute("/_app")({
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
		return { user };
	},
	component: AppLayout,
});

function AppLayout() {
	useLiveHostSamples();
	return (
		<SidebarProvider>
			<CommandMenuProvider>
				<AppSidebar />
				<SidebarInset className="min-w-0">
					<TopBar />
					<Outlet />
				</SidebarInset>
			</CommandMenuProvider>
		</SidebarProvider>
	);
}
