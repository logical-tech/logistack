import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { organization, user } from "./auth.ts";
import { timestamps, tstz } from "./columns.ts";
import { project } from "./hierarchy.ts";
import { gitProvider } from "./integrations.ts";

export type GitopsError = {
	at: string;
	commitSha: string | null;
	message: string;
	details: string[];
};

/**
 * A project whose desired state follows a manifest in a git repository. A push to `branch` that
 * touches the file applies it; with `managed`, the API refuses manual edits to the project.
 */
export const projectGitops = pgTable("project_gitops", {
	projectId: text("project_id")
		.primaryKey()
		.references(() => project.id, { onDelete: "cascade" }),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	gitProviderId: text("git_provider_id")
		.notNull()
		.references(() => gitProvider.id, { onDelete: "cascade" }),
	repository: text("repository").notNull(),
	branch: text("branch").notNull(),
	/** Path of the project manifest inside the repository. */
	path: text("path").notNull(),
	/** Apply on every push that changes the file; off, a push only records the diff. */
	autoApply: boolean("auto_apply").notNull().default(true),
	/** Delete what the manifest does not list. */
	prune: boolean("prune").notNull().default(false),
	/** Manual edits through the API and UI are refused; the repository is the only way in. */
	managed: boolean("managed").notNull().default(false),
	lastCommitSha: text("last_commit_sha"),
	lastSyncedAt: tstz("last_synced_at"),
	/** `applied`, `unchanged`, `planned` (auto apply off) or `failed`. */
	lastStatus: text("last_status").$type<
		"applied" | "unchanged" | "planned" | "failed"
	>(),
	lastChanges: integer("last_changes"),
	lastError: jsonb("last_error").$type<GitopsError>(),
	createdBy: text("created_by").references(() => user.id, {
		onDelete: "set null",
	}),
	...timestamps,
});
