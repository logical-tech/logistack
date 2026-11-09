import { router } from "../../openapi.ts";
import { workAi } from "./ai.ts";
import { workReports } from "./reports.ts";
import { workTemplates } from "./templates.ts";
import { workTime } from "./time.ts";

/** Time tracking, templates, workload and AI assist (plan 12.1, 12.3, 12.10, 12.11). */
export const workExtrasA = router()
	.route("/", workTime)
	.route("/", workTemplates)
	.route("/", workReports)
	.route("/", workAi);
