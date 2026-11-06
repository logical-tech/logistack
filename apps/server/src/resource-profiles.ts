import { ResourceProfiles } from "@logistack/contracts";
import { seededResourceProfiles } from "@logistack/core";
import { type Db, organization } from "@logistack/db";
import { eq, sql } from "drizzle-orm";

// Stored in `organization.metadata` next to the two-factor policy: no table, no migration.
const metadataJson = sql`coalesce(${organization.metadata}::jsonb, '{}'::jsonb)`;

export async function readResourceProfiles(
	db: Db,
	organizationId: string,
): Promise<ResourceProfiles> {
	const [row] = await db
		.select({ stored: sql<unknown>`${metadataJson}->'resourceProfiles'` })
		.from(organization)
		.where(eq(organization.id, organizationId));
	const parsed = ResourceProfiles.safeParse(row?.stored);
	return parsed.success ? parsed.data : seededResourceProfiles;
}

export async function writeResourceProfiles(
	db: Db,
	organizationId: string,
	next: ResourceProfiles,
) {
	await db
		.update(organization)
		.set({
			metadata: sql`(${metadataJson} || jsonb_build_object('resourceProfiles', ${JSON.stringify(next)}::jsonb))::text`,
		})
		.where(eq(organization.id, organizationId));
}
