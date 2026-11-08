import type { Metadata } from "next";
import { PageShell } from "@/components/page-shell";
import { FinalCta } from "@/components/sections/closing";
import { site } from "@/content/site";
import { allPosts, readPost, slugify } from "@/lib/blog";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
	return allPosts().map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
	const p = readPost((await params).slug);
	const url = `/blog/${p.slug}/`;
	return {
		title: p.title,
		description: p.description,
		keywords: p.keywords,
		alternates: { canonical: url },
		openGraph: {
			type: "article",
			url,
			title: p.title,
			description: p.description,
			publishedTime: p.date,
			section: p.category,
			tags: p.keywords,
		},
		twitter: {
			card: "summary_large_image",
			title: p.title,
			description: p.description,
		},
	};
}

const dateFmt = new Intl.DateTimeFormat("en", {
	year: "numeric",
	month: "long",
	day: "numeric",
	timeZone: "UTC",
});

export default async function BlogPost({ params }: Props) {
	const p = readPost((await params).slug);
	const url = `${site.url}/blog/${p.slug}/`;
	const all = allPosts().filter((o) => o.slug !== p.slug);
	const related = [
		...all.filter((o) => o.category === p.category),
		...all.filter((o) => o.category !== p.category),
	].slice(0, 4);

	const jsonLd = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "BlogPosting",
				"@id": `${url}#post`,
				mainEntityOfPage: url,
				url,
				headline: p.title,
				description: p.description,
				datePublished: p.date,
				dateModified: p.date,
				articleSection: p.category,
				keywords: p.keywords.join(", "),
				wordCount: p.minutes * 230,
				inLanguage: "en",
				author: { "@id": `${site.url}/#org` },
				publisher: { "@id": `${site.url}/#org` },
				image: `${site.url}/opengraph-image`,
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{
						"@type": "ListItem",
						position: 1,
						name: site.name,
						item: `${site.url}/`,
					},
					{
						"@type": "ListItem",
						position: 2,
						name: "Blog",
						item: `${site.url}/blog/`,
					},
					{ "@type": "ListItem", position: 3, name: p.title, item: url },
				],
			},
		],
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
			<div className="mx-auto w-full max-w-[1440px] px-4 pt-10 sm:px-10 sm:pt-14">
				<a
					href="/blog/"
					className="inline-flex h-10 items-center gap-2 rounded-full text-sm text-muted transition-colors hover:text-fg"
				>
					<svg
						viewBox="0 0 24 24"
						aria-hidden
						className="size-4"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="m15 18-6-6 6-6" />
					</svg>
					All posts
				</a>
			</div>

			<article className="mx-auto w-full max-w-[1440px] px-4 sm:px-10">
				<header className="flex max-w-[26ch] flex-col gap-6 pt-8 pb-10 sm:pb-14">
					<h1 className="rise text-[36px] leading-[1.06] font-medium tracking-[-0.035em] sm:text-[52px]">
						{p.title}
					</h1>
				</header>
				<div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_280px] xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-20">
					<div className="flex min-w-0 flex-col gap-10">
						<div className="rise flex max-w-[68ch] flex-col gap-4 [animation-delay:80ms]">
							<p className="text-xl leading-relaxed text-fg/90">
								{p.description}
							</p>
							<p className="text-sm text-faint">
								<a
									href={`/blog/#${slugify(p.category)}`}
									className="text-muted transition-colors hover:text-fg"
								>
									{p.category}
								</a>
								{" · "}
								<time dateTime={p.date}>
									{dateFmt.format(new Date(p.date))}
								</time>
								{" · "}
								<span className="tabular-nums">{p.minutes} min read</span>
							</p>
						</div>
						<div
							className="prose"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown from our own repo, rendered at build time
							dangerouslySetInnerHTML={{ __html: p.html }}
						/>
					</div>
					{p.headings.length > 2 && (
						<aside className="hidden lg:block">
							<nav
								aria-label="On this page"
								className="sticky top-[96px] flex flex-col gap-3 rounded-[24px] bg-step p-6"
							>
								<p className="text-sm font-medium">On this page</p>
								<ul className="flex flex-col gap-2">
									{p.headings.map((h) => (
										<li key={h.id}>
											<a
												href={`#${h.id}`}
												className="block text-[14px] leading-snug text-muted transition-colors hover:text-fg"
											>
												{h.text}
											</a>
										</li>
									))}
								</ul>
								<a
									href="/#install"
									className="pressable mt-3 inline-flex h-10 w-fit items-center rounded-full bg-fg px-[18px] text-sm font-medium text-bg hover:bg-white"
								>
									Install LogiStack
								</a>
							</nav>
						</aside>
					)}
				</div>
			</article>

			<section
				aria-labelledby="related-title"
				className="mx-auto w-full max-w-[1440px] px-4 pt-32 sm:px-10"
			>
				<h2
					id="related-title"
					className="text-[32px] leading-[1.05] font-medium tracking-[-0.03em] sm:text-[40px]"
				>
					Keep reading
				</h2>
				<ul className="mt-8 grid gap-2 sm:grid-cols-2">
					{related.map((o) => (
						<li key={o.slug}>
							<a
								href={`/blog/${o.slug}/`}
								className="flex h-full flex-col gap-2 rounded-[24px] bg-step p-6 transition-colors duration-150 hover:bg-raised sm:p-8"
							>
								<span className="text-[13px] text-faint">{o.category}</span>
								<span className="text-[20px] leading-snug font-medium tracking-[-0.015em]">
									{o.title}
								</span>
								<span className="text-[15px] leading-relaxed text-muted">
									{o.description}
								</span>
							</a>
						</li>
					))}
				</ul>
			</section>

			<FinalCta />
		</PageShell>
	);
}
