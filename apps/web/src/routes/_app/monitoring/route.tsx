import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/monitoring")({
	staticData: { crumb: "Monitoring" },
	component: Outlet,
});
