import type { MetadataRoute } from "next";
import { absolute } from "@/lib/shared";
import { source } from "@/lib/source";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
	return source.getPages().map((page) => ({
		url: absolute(page.url),
		lastModified: page.data.lastModified ?? new Date(),
		changeFrequency: "weekly",
		priority: page.slugs.length === 0 ? 0.9 : 0.7,
	}));
}
