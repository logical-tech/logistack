import { router } from "../../openapi.ts";
import { meRoutes } from "./me.ts";
import { projectRoutes } from "./projects.ts";
import { searchRoutes } from "./search.ts";
import { structureRoutes } from "./structure.ts";
import { taskRoutes } from "./tasks.ts";

/** Work API: projects, structure, tasks, search and my tasks (docs/plans/project-management.md, section 8). */
export const workRoutes = router()
	.route("/", projectRoutes)
	.route("/", structureRoutes)
	.route("/", taskRoutes)
	.route("/", searchRoutes)
	.route("/", meRoutes);
