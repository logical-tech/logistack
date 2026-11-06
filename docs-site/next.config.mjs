import { createMDX } from "fumadocs-mdx/next";

/** Served at <site>/docs by its own container; the marketing site owns every other path. */
const config = {
	basePath: "/docs",
	output: "export",
	trailingSlash: true,
	reactStrictMode: true,
	poweredByHeader: false,
	images: { unoptimized: true },
	turbopack: { root: import.meta.dirname },
};

export default createMDX()(config);
