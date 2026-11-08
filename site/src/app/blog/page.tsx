import type { Metadata } from "next";
import { PageHead, PageShell } from "@/components/page-shell";
import { FinalCta } from "@/components/sections/closing";
import { site } from "@/content/site";
import { allPosts, categories, slugify } from "@/lib/blog";

export const metadata: Metadata = {
	title: "Blog: self-hosting, Docker and deployment guides",
	description:
		"Practical guides on self-hosting, Docker, Swarm, reverse proxies, databases, backups and security, plus honest comparisons of PaaS platforms and their alternatives.",
	alternates: {
		canonical: "/blog/",
		types: { "application/rss+xml": "/blog/rss.xml" },
	},
	openGraph: { url: "/blog/", type: "website" },
};

export default function Blog() {
	const posts = allPosts();
	const groups = categories
		.map((c) => ({
			c,
			id: slugify(c),
			items: posts.filter((p) => p.category === c),
		}))
		.filter((g) => g.items.length > 0);

	const jsonLd = {
		"@context": "https://schema.org",
		"@type": "Blog",
		"@id": `${site.url}/blog/#blog`,
		url: `${site.url}/blog/`,
		name: `${site.name} blog`,
		publisher: { "@id": `${site.url}/#org` },
		blogPost: posts.map((p) => ({
			"@type": "BlogPosting",
			headline: p.title,
			url: `${site.url}/blog/${p.slug}/`,
			datePublished: p.date,
		})),
	};

	return (
		<PageShell>
			<script
				type="application/ld+json"
				// biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD built from our own content
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
				}}
			/>
			<PageHead title="Notes on running your own platform.">
				<p>
					{posts.length} guides and comparisons from the people who build
					LogiStack: Docker, Swarm, proxies, databases, backups, security, and
					how the hosted platforms stack up against running it yourself.
				</p>
			</PageHead>

			<nav
				aria-label="Blog topics"
				className="mx-auto w-full max-w-[1440px] px-4 sm:px-10"
			>
				<ul className="flex flex-wrap gap-2">
					{groups.map((g) => (
						<li key={g.id}>
							<a
								href={`#${g.id}`}
								className="pressable inline-flex h-9 items-center gap-2 rounded-full bg-raised px-3.5 text-[13px] font-medium text-muted hover:text-fg"
							>
								{g.c}
								<span className="text-faint tabular-nums">
									{g.items.length}
								</span>
							</a>
						</li>
					))}
				</ul>
			</nav>

			<div className="mx-auto flex w-full max-w-[1440px] flex-col gap-2 px-4 pt-16 sm:px-10 sm:pt-24">
				{groups.map((g, i) => (
					<section
						key={g.id}
						id={g.id}
						aria-labelledby={`${g.id}-title`}
						className={`grid gap-6 rounded-[28px] p-6 sm:p-10 lg:grid-cols-[300px_1fr] lg:gap-12 xl:grid-cols-[400px_1fr] xl:gap-16 ${i % 2 === 0 ? "bg-step" : ""}`}
					>
						<h2
							id={`${g.id}-title`}
							className="reveal text-[32px] leading-[1.05] font-medium tracking-[-0.03em] sm:text-[40px] lg:sticky lg:top-[96px] lg:self-start"
						>
							{g.c}
						</h2>
						<ul className="flex flex-col">
							{g.items.map((p) => (
								<li key={p.slug} className="reveal">
									<a
										href={`/blog/${p.slug}/`}
										className="group -mx-4 flex flex-col gap-1.5 rounded-[18px] px-4 py-4 transition-colors duration-150 hover:bg-raised"
									>
										<span className="text-[19px] leading-snug font-medium tracking-[-0.01em]">
											{p.title}
										</span>
										<span className="max-w-[70ch] text-[15px] leading-relaxed text-muted">
											{p.description}
										</span>
										<span className="text-[13px] text-faint tabular-nums">
											{p.minutes} min read
										</span>
									</a>
								</li>
							))}
						</ul>
					</section>
				))}
			</div>

			<FinalCta />
		</PageShell>
	);
}
