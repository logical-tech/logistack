import type { MetadataRoute } from "next";
import { site } from "@/content/site";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
	return {
		name: site.name,
		short_name: site.name,
		description: site.description,
		start_url: "/",
		display: "browser",
		background_color: "#111214",
		theme_color: "#111214",
		icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
	};
}
