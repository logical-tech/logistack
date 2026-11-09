import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { meQuery } from "@/lib/api/access";

/** Work routes need the `work` surface; an ops-only actor goes home instead of a 403. */
export const Route = createFileRoute("/_app/work")({
	beforeLoad: async ({ context }) => {
		const me = await context.queryClient
			.ensureQueryData(meQuery)
			.catch(() => undefined);
		const surfaces = (me as { surfaces?: string[] } | undefined)?.surfaces;
		if (surfaces && !surfaces.includes("work")) throw redirect({ to: "/" });
	},
	staticData: { crumb: "Tasks" },
	component: Outlet,
});
