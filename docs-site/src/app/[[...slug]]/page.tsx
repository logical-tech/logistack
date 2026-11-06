import {
	DocsBody,
	DocsDescription,
	DocsPage,
	DocsTitle,
	MarkdownCopyButton,
	PageLastUpdate,
	ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import {
	absolute,
	basePath,
	getPageImageUrl,
	getPageMarkdownUrl,
	gitConfig,
	site,
} from "@/lib/shared";
import { source } from "@/lib/source";

export default async function Page(props: PageProps<"/[[...slug]]">) {
	const params = await props.params;
	const page = source.getPage(params.slug);
	if (!page) notFound();

	const MDX = page.data.body;
	const markdownUrl = `${basePath}${getPageMarkdownUrl(page).url}`;
	const lastModified = page.data.lastModified;

	// Breadcrumbs from the URL: each prefix that is itself a page becomes a crumb.
	const crumbs = page.slugs.flatMap((_, i) => {
		const p = source.getPage(page.slugs.slice(0, i + 1));
		return p ? [{ name: p.data.title, url: absolute(p.url) }] : [];
	});
	const jsonLd = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "TechArticle",
				headline: page.data.title,
				description: page.data.description,
				url: absolute(page.url),
				image: `${site.url}${getPageImageUrl(page).url}`,
				inLanguage: "en",
				...(lastModified && { dateModified: lastModified.toISOString() }),
				author: {
					"@type": "Organization",
					name: site.company.name,
					url: site.company.url,
				},
				publisher: {
					"@type": "Organization",
					name: site.company.name,
					url: site.company.url,
				},
				isPartOf: {
					"@type": "WebSite",
					name: site.docsName,
					url: `${site.url}/`,
				},
				about: {
					"@type": "SoftwareApplication",
					name: site.name,
					url: `${site.origin}/`,
				},
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [{ name: "Docs", url: `${site.url}/` }, ...crumbs].map(
					(c, i) => ({
						"@type": "ListItem",
						position: i + 1,
						name: c.name,
						item: c.url,
					}),
				),
			},
		],
	};

	return (
		<DocsPage toc={page.data.toc} full={page.data.full}>
			<script
				type="application/ld+json"
				// biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD built from page frontmatter
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
				}}
			/>
			<DocsTitle>{page.data.title}</DocsTitle>
			<DocsDescription className="mb-0">
				{page.data.description}
			</DocsDescription>
			<div className="flex flex-row items-center gap-2 border-b pb-6">
				<MarkdownCopyButton markdownUrl={markdownUrl} />
				<ViewOptionsPopover
					markdownUrl={`${site.origin}${markdownUrl}`}
					githubUrl={`${site.github}/blob/${gitConfig.branch}/docs-site/content/docs/${page.path}`}
				/>
			</div>
			<DocsBody>
				<MDX
					components={getMDXComponents({ a: createRelativeLink(source, page) })}
				/>
			</DocsBody>
			{lastModified && <PageLastUpdate date={lastModified} />}
		</DocsPage>
	);
}

export function generateStaticParams() {
	return source.generateParams();
}

export async function generateMetadata(
	props: PageProps<"/[[...slug]]">,
): Promise<Metadata> {
	const params = await props.params;
	const page = source.getPage(params.slug);
	if (!page) notFound();
	const url = absolute(page.url);
	const image = `${site.url}${getPageImageUrl(page).url}`;
	const isRoot = page.slugs.length === 0;
	return {
		title: isRoot
			? { absolute: `${site.docsName}: ${page.data.title}` }
			: page.data.title,
		description: page.data.description,
		alternates: {
			canonical: url,
			types: {
				"text/markdown": `${site.origin}${basePath}${getPageMarkdownUrl(page).url}`,
			},
		},
		openGraph: {
			type: "article",
			url,
			title: page.data.title,
			description: page.data.description,
			images: [{ url: image, width: 1200, height: 630 }],
			...(page.data.lastModified && {
				modifiedTime: page.data.lastModified.toISOString(),
			}),
		},
		twitter: {
			card: "summary_large_image",
			title: page.data.title,
			images: [image],
		},
	};
}
