import { site } from "@/content/site";
import { allPosts } from "@/lib/blog";

export const dynamic = "force-static";

/** llms.txt at the root, as crawlers look for it; the full index lives with the docs. */
export function GET() {
	return new Response(
		`# ${site.name}

> ${site.description}

Install: \`${site.install}\`

## Docs

- [Documentation index for LLMs](${site.url}${site.docs}llms.txt): every docs page with a one-line summary
- [Full documentation in one file](${site.url}${site.docs}llms-full.txt)
- [Docs home](${site.url}${site.docs})

## Site

- [Features](${site.url}/features/)
- [Templates](${site.url}/templates/)
- [Blog](${site.url}/blog/)
- [Source code](${site.github})

## Blog

${allPosts()
	.map((p) => `- [${p.title}](${site.url}/blog/${p.slug}/): ${p.description}`)
	.join("\n")}
`,
		{ headers: { "Content-Type": "text/plain; charset=utf-8" } },
	);
}
