import { site } from "@/content/site";
import { allPosts } from "@/lib/blog";

export const dynamic = "force-static";

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function GET() {
	const items = allPosts()
		.map(
			(p) =>
				`<item><title>${esc(p.title)}</title><link>${site.url}/blog/${p.slug}/</link><guid>${site.url}/blog/${p.slug}/</guid><pubDate>${new Date(p.date).toUTCString()}</pubDate><category>${esc(p.category)}</category><description>${esc(p.description)}</description></item>`,
		)
		.join("");
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${site.name} blog</title><link>${site.url}/blog/</link><description>Guides on self-hosting, Docker and deployment.</description><language>en</language>${items}</channel></rss>`,
		{ headers: { "Content-Type": "application/rss+xml; charset=utf-8" } },
	);
}
