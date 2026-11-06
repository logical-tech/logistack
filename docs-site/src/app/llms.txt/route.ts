import { absolute } from "@/lib/shared";
import { llmsPreamble, source } from "@/lib/source";

export const revalidate = false;

export function GET() {
	const lines = source
		.getPages()
		.map(
			(p) =>
				`- [${p.data.title}](${absolute(p.url)}): ${p.data.description ?? ""}`,
		);
	return new Response(`${llmsPreamble}\n## Pages\n\n${lines.join("\n")}\n`, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}
