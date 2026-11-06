/** Serves out/ the way production should: gzip for text, immutable cache for hashed assets. */

import { extname, join, normalize } from "node:path";
import { file } from "bun";

const root = join(import.meta.dir, "..", "out");
const port = Number(process.env.PORT ?? 4321);
const TEXT = new Set([
	".html",
	".css",
	".js",
	".json",
	".txt",
	".xml",
	".svg",
	".webmanifest",
]);

Bun.serve({
	port,
	async fetch(req) {
		let path = normalize(decodeURIComponent(new URL(req.url).pathname));
		if (path.endsWith("/")) path += "index.html";
		let f = file(join(root, path));
		if (!(await f.exists())) f = file(join(root, `${path}.html`));
		if (!(await f.exists()))
			return new Response(file(join(root, "404.html")), {
				status: 404,
				headers: { "content-type": "text/html" },
			});
		const headers = new Headers({ "content-type": f.type });
		headers.set(
			"cache-control",
			path.startsWith("/_next/static/")
				? "public, max-age=31536000, immutable"
				: "public, max-age=0, must-revalidate",
		);
		if (
			TEXT.has(extname(f.name ?? "")) &&
			req.headers.get("accept-encoding")?.includes("gzip")
		) {
			headers.set("content-encoding", "gzip");
			return new Response(Bun.gzipSync(new Uint8Array(await f.arrayBuffer())), {
				headers,
			});
		}
		return new Response(f, { headers });
	},
});
console.log(`serving ${root} on http://localhost:${port}`);
