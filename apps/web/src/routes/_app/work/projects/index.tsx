import { createFileRoute } from "@tanstack/react-router";
import { ProjectsGrid } from "@/components/work/projects-grid";

export const Route = createFileRoute("/_app/work/projects/")({
	staticData: { crumb: "Projects" },
	component: ProjectsGrid,
});
