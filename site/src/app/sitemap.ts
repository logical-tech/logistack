import type { MetadataRoute } from "next";
import { site } from "@/content/site";
import { allPosts } from "@/lib/blog";
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
		{
			url: `${site.url}/blog/`,
			lastModified,
			changeFrequency: "weekly",
			priority: 0.8,
		},
		...allPosts().map(({ slug, date }) => ({
			url: `${site.url}/blog/${slug}/`,
			lastModified: new Date(date),
			changeFrequency: "monthly" as const,
			priority: 0.7,
		})),
		...catalogIndex().map(({ id }) => ({
			url: `${site.url}/templates/${id}/`,
			lastModified,
			changeFrequency: "monthly" as const,
			priority: 0.6,
		})),
	];
}
