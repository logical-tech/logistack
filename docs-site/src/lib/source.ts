import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { absolute, site } from "./shared";

const docs = defineDocs({
	dir: "content/docs",
	docs: {
		schema: pageSchema,
		lastModified: true,
		postprocess: { includeProcessedMarkdown: true },
	},
	meta: { schema: metaSchema },
});

export const source = loader({
	baseUrl: "/",
	source: docs.toFumadocsSource(),
	plugins: [lucideIconsPlugin()],
});

export const docsLlms = llms(source, {
	renderPage: async (page) =>
		`# ${page.data.title}\n\nURL: ${absolute(page.url)}\n\n${page.data.description ?? ""}\n\n${await page.data.getText("processed")}`,
});

export const llmsPreamble = `# ${site.docsName}

> LogiStack is an open-source (Apache 2.0), self-hosted platform as a service (PaaS) built on Docker Swarm. You install it on your own Linux server with one command and deploy apps from Git, a Docker image, a compose file or one of 500+ templates, with automatic HTTPS, databases, backups, S3 storage, metrics, a web dashboard, a REST API and an MCP server for AI agents.

Install: \`${site.install}\`
Website: ${site.origin}/
Source: ${site.github}
Full docs as one file: ${site.url}/llms-full.txt
Every page is also available as Markdown by appending \`content.md\` under ${site.url}/llms.mdx/ (for example ${site.url}/llms.mdx/getting-started/install/content.md).
`;
