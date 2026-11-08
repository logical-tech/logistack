import type {
	ScanStatus,
	VulnCounts,
	VulnSeverity,
} from "@logistack/contracts";
import { jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { timestamps, tstz } from "./columns.ts";
import { service } from "./hierarchy.ts";

/** One scan result per image digest, shared by every service that runs that digest. */
export const imageScan = pgTable("image_scan", {
	digest: text("digest").primaryKey(),
	/** The reference last scanned for this digest. */
	image: text("image").notNull(),
	status: text("status").$type<ScanStatus>().notNull(),
	counts: jsonb("counts").$type<VulnCounts>(),
	error: text("error"),
	scannedAt: tstz("scanned_at"),
	...timestamps,
});

export const imageVulnerability = pgTable(
	"image_vulnerability",
	{
		digest: text("digest")
			.notNull()
			.references(() => imageScan.digest, { onDelete: "cascade" }),
		vulnerabilityId: text("vulnerability_id").notNull(),
		pkgName: text("pkg_name").notNull(),
		installedVersion: text("installed_version").notNull(),
		fixedVersion: text("fixed_version"),
		severity: text("severity").$type<VulnSeverity>().notNull(),
		title: text("title"),
		url: text("url"),
	},
	(t) => [
		primaryKey({
			name: "image_vulnerability_pk",
			columns: [t.digest, t.vulnerabilityId, t.pkgName, t.installedVersion],
		}),
	],
);

/** The image a service runs now, as the scanner last saw it in Swarm. */
export const serviceImage = pgTable("service_image", {
	serviceId: text("service_id")
		.primaryKey()
		.references(() => service.id, { onDelete: "cascade" }),
	image: text("image").notNull(),
	digest: text("digest").notNull(),
	...timestamps,
});
