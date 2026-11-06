import type { MetadataRoute } from "next";
import { site } from "@/content/site";
import { catalogIndex } from "@/lib/catalog";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
	const lastModified = new Date();
	return [
		{
			url: `${site.url}/`,
			lastModified,
			changeFrequency: "weekly",
			priority: 1,
		},
		{
			url: `${site.url}/features/`,
			lastModified,
			changeFrequency: "weekly",
			priority: 0.9,
		},
		{
			url: `${site.url}/templates/`,
			lastModified,
			changeFrequency: "weekly",
			priority: 0.9,
		},
		...catalogIndex().map(({ id }) => ({
			url: `${site.url}/templates/${id}/`,
			lastModified,
			changeFrequency: "monthly" as const,
			priority: 0.6,
		})),
	];
}
