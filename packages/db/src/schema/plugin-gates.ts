import { boolean, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { tstz } from "./columns.ts";
import { pluginInstall } from "./plugins.ts";
import { deployment } from "./runtime.ts";

/**
 * A plugin's answer to a deploy gate (docs/plans/plugins.md, phase 4), one per deployment and
 * install: a retried or resumed deployment reuses it instead of asking again. Timeouts are not
 * stored; they are asked again on the next attempt.
 */
export const pluginGateDecision = pgTable(
	"plugin_gate_decision",
	{
		deploymentId: text("deployment_id")
			.notNull()
			.references(() => deployment.id, { onDelete: "cascade" }),
		installId: text("install_id")
			.notNull()
			.references(() => pluginInstall.id, { onDelete: "cascade" }),
		allowed: boolean("allowed").notNull(),
		reason: text("reason"),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.deploymentId, t.installId] })],
);
