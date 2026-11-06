import { z } from "zod";
import { Resources } from "./service-spec.ts";

/** Decoded size cap for an organization logo; the web resizes to 256×256 WebP well under it. */
export const ORG_LOGO_MAX_BYTES = 128 * 1024;

const LOGO_PREFIX =
	/^data:image\/(png|webp|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * A raster image as a data URL. SVG is refused: it can carry script, and the logo
 * becomes every member's favicon.
 */
export const OrganizationLogo = z
	.string()
	.regex(LOGO_PREFIX, "Use a PNG, WebP or JPEG image")
	.refine(
		(v) =>
			Math.floor(((v.split(",")[1] ?? "").length * 3) / 4) <=
			ORG_LOGO_MAX_BYTES,
		`The logo must be ${ORG_LOGO_MAX_BYTES / 1024} KB or smaller`,
	);

export const OrganizationUpdate = z
	.object({
		name: z.string().trim().min(1).max(80),
		/** `null` removes the logo. */
		logo: OrganizationLogo.nullable(),
	})
	.partial();
export type OrganizationUpdate = z.infer<typeof OrganizationUpdate>;

/** A named size that services copy into their spec; editing it later never resizes a service. */
export const ResourceProfile = Resources.extend({
	name: z.string().trim().min(1, "Every profile needs a name").max(40),
});
export type ResourceProfile = z.infer<typeof ResourceProfile>;

export const ResourceProfiles = z
	.object({
		profiles: z.array(ResourceProfile).max(50),
		/** Profile copied into new services that set no limits; null for none. */
		defaultProfile: z.string().nullable(),
	})
	.refine(
		(s) => new Set(s.profiles.map((p) => p.name)).size === s.profiles.length,
		{ message: "profile names must be unique", path: ["profiles"] },
	)
	.refine(
		(s) =>
			s.defaultProfile === null ||
			s.profiles.some((p) => p.name === s.defaultProfile),
		{
			message: "the default must be one of the profiles",
			path: ["defaultProfile"],
		},
	);
export type ResourceProfiles = z.infer<typeof ResourceProfiles>;
