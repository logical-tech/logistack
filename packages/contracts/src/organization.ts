import { z } from "zod";

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
