import { createFileRoute } from "@tanstack/react-router";
import { MyTasks } from "@/components/work/my-tasks";

export const Route = createFileRoute("/_app/work/")({
	staticData: { crumb: "My tasks" },
	component: MyTasks,
});
