import { createGetUrl } from "fumadocs-core/source";

/** Next's basePath: every route and asset of this app lives under it. */
export const basePath = "/docs";
const origin =
	process.env.NEXT_PUBLIC_SITE_URL ?? "https://stack.logicaltech.it";
export const site = {
	name: "LogiStack",
	docsName: "LogiStack Docs",
	origin,
	/** Absolute URL of the docs root, without a trailing slash. */
	url: `${origin}${basePath}`,
	github: "https://github.com/logical-tech/logistack",
	install: `curl -fsSL ${origin}/install.sh | sudo bash`,
	company: { name: "Logical", url: "https://logicaltech.it" },
} as const;

export const gitConfig = {
	user: "logical-tech",
	repo: "logistack",
	branch: "main",
};

/** Absolute URL of a docs page path such as `/deploy/git/`. */
export const absolute = (path: string) =>
	`${site.url}${path === "/" ? "/" : `${path.replace(/\/$/, "")}/`}`;

const getContentUrl = createGetUrl("/llms.mdx");
/** The page as plain Markdown, for LLMs and the "Copy Markdown" button. */
export function getPageMarkdownUrl(page: { slugs: string[] }) {
	const segments = [...page.slugs, "content.md"];
	return { segments, url: getContentUrl(segments) };
}

const getImageUrl = createGetUrl("/og");
export function getPageImageUrl(page: { slugs: string[] }) {
	const segments = [...page.slugs, "image.png"];
	return { segments, url: getImageUrl(segments) };
}
