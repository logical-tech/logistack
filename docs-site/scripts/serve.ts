/** Serves out/ under /docs the way Caddy does in production, for local checks. */

import { join, normalize } from "node:path";
import { file } from "bun";

const root = join(import.meta.dir, "..", "out");
const port = Number(process.env.PORT ?? 4322);
const TYPES: Record<string, string> = {
	".md": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

Bun.serve({
	port,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/docs") return Response.redirect("/docs/", 308);
		if (!url.pathname.startsWith("/docs/"))
			return new Response("Not found", { status: 404 });
		let path = normalize(
			decodeURIComponent(url.pathname.slice("/docs".length)),
		);
		if (path.endsWith("/")) path += "index.html";
		let f = file(join(root, path));
		if (!(await f.exists())) f = file(join(root, `${path}.html`));
		if (!(await f.exists()))
			return new Response(file(join(root, "404.html")), {
				status: 404,
				headers: { "content-type": "text/html" },
			});
		const ext = path.slice(path.lastIndexOf("."));
		const type = path.startsWith("/og/")
			? "image/png"
			: path === "/api/search"
				? "application/json"
				: (TYPES[ext] ?? f.type);
		return new Response(f, { headers: { "content-type": type } });
	},
});
console.log(`serving ${root} on http://localhost:${port}/docs/`);
