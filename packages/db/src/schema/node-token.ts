import { pgTable, text } from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { id, tstz } from "./columns.ts";
import { node } from "./runtime.ts";

/** Per-node agent credentials, issued when an agent enrolls with the installer's token. Only the sha256 is stored. */
export const nodeToken = pgTable("node_token", {
	id: id("ntk"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	nodeId: text("node_id")
		.notNull()
		.references(() => node.id, { onDelete: "cascade" }),
	/** Hex sha256 of the token. */
	tokenHash: text("token_hash").notNull().unique(),
	createdAt: tstz("created_at").defaultNow().notNull(),
	lastUsedAt: tstz("last_used_at"),
	/** Set by an operator; the node is refused, also when it presents the enrollment token again. */
	revokedAt: tstz("revoked_at"),
});
