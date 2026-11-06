import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { catalogDir } from "@/lib/catalog";

export const dynamic = "force-static";

const TYPES: Record<string, string> = {
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
};

/** The catalog's logos, written into the static export at /logos/<file>. */
export function generateStaticParams() {
	return readdirSync(join(catalogDir, "logos"))
		.filter((file) => extname(file) in TYPES)
		.map((file) => ({ file }));
}

export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ file: string }> },
) {
	const { file } = await params;
	const type = TYPES[extname(file)];
	if (!type || !/^[a-z0-9-]+\.[a-z]+$/.test(file))
		return new Response(null, { status: 404 });
	return new Response(readFileSync(join(catalogDir, "logos", file)), {
		headers: { "content-type": type },
	});
}
