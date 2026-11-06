import type { Metadata } from "next";
import { PageHead, PageShell } from "@/components/page-shell";
import { FinalCta } from "@/components/sections/closing";
import { TemplateGallery } from "@/components/template-gallery";
import { catalogIndex, categoryLabel } from "@/lib/catalog";

const count = catalogIndex().length;

export const metadata: Metadata = {
	title: `${count} self-hosted apps you can deploy in one click`,
	description: `Browse the LogiStack template catalog: ${count} open-source apps, from databases and wikis to analytics, AI and media servers. Each one deploys with its volumes, domain, HTTPS and generated secrets.`,
	alternates: { canonical: "/templates/" },
};

export default function Templates() {
	const items = catalogIndex().map(
		({ id, name, description, category, tags, logo, services }) => ({
			id,
			name,
			description,
			category,
			tags,
			logo,
			services,
		}),
	);
	const counts = new Map<string, number>();
	for (const t of items)
		counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
	const categories = [...counts]
		// "Other" last, the rest by size.
		.sort(([a, x], [b, y]) => (a === "other" ? 1 : b === "other" ? -1 : y - x))
		.map(([id, n]) => [id, categoryLabel(id), n] as [string, string, number]);

	return (
		<PageShell>
			<PageHead title={`${count} apps, one click each.`}>
				<p>
					Pick an app and LogiStack creates its services, volumes, internal
					network, domain and HTTPS certificate. Passwords and keys are
					generated and stored encrypted; you are asked only for what can't be
					generated, such as an admin email.
				</p>
			</PageHead>
			<section
				aria-label="Template catalog"
				className="mx-auto w-full max-w-[1440px] px-4 sm:px-10"
			>
				<TemplateGallery items={items} categories={categories} />
			</section>
			<FinalCta />
		</PageShell>
	);
}
